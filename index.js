require("dotenv").config();
const { App } = require("@slack/bolt");
const axios = require("axios");
const {
  getUser,
  createUser,
  updateUser,
  getNation,
  getAllNations,
  updateNation,
  getElection,
  updateElection,
  getTrades,
  createTrade,
  acceptTrade,
  rejectTrade,
  getWars,
  declareWar,
  endWar,
  getItem,
  getAllItems,
} = require("./data/db");
require("./gameLoop");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

app.error(async (error) => {
  console.error("[BOLT GLOBAL ERROR]", error);
});

// Permission helpers — check if a user can access economic/military actions
function hasEconomicPerms(user, nation) {
  if (user.role === "president" || user.role === "vice_president") return true;
  const role = nation.roles?.[user.role];
  return !!role?.permissions?.includes("economic");
}

function hasMilitaryPerms(user, nation) {
  if (user.role === "president" || user.role === "general") return true;
  const role = nation.roles?.[user.role];
  return !!role?.permissions?.includes("military");
}

// Cooldown helper — returns remaining ms, or 0 if ready
function getCooldownRemaining(user, action, cooldownMs) {
  const last = user.cooldowns?.[action];
  if (!last) return 0;
  const elapsed = Date.now() - new Date(last).getTime();
  return Math.max(0, cooldownMs - elapsed);
}

function formatCooldown(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// Term limit: max 2 terms per user within a rolling 90-day window
const TERM_LIMIT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // ~3 months
const MAX_TERMS_IN_WINDOW = 2;

function isEligibleForPresident(userId, nation) {
  const history = nation.term_history || [];
  const cutoff = Date.now() - TERM_LIMIT_WINDOW_MS;
  const recentTerms = history.filter(
    (t) => t.user_id === userId && new Date(t.started_at).getTime() >= cutoff
  );
  return recentTerms.length < MAX_TERMS_IN_WINDOW;
}

// /kal-ping command
app.command("/kal-ping", async ({ command, ack, respond }) => {
  const start = Date.now();
  await ack();
  const latency = Date.now() - start;
  await respond({ text: `Pong!\nLatency: ${latency}ms` });
});

// /kal-help command
app.command("/kal-help", async ({ ack, respond }) => {
  await ack();
  await respond({
    text: `Available Commands:
/kal-ping - Check bot latency
/kal-join - Join the game!
/kal-actions - Manage your nation`,
  });
});

// /kal-join command
app.command("/kal-join", async ({ ack, body, respond }) => {
  await ack();

  try {
    const userId = body.user_id;
    const userName = body.user_name;

    console.log(`[kal-join] User ${userId} (${userName}) attempting to join`);

    let user = getUser(userId);
    if (!user) {
      console.log(`[kal-join] Creating new user: ${userId}`);
      createUser(userId, userName);
      user = getUser(userId);
    }

    if (user.nation_id) {
      console.log(`[kal-join] User already in nation ${user.nation_id}`);
      const nation = getNation(user.nation_id);
      await respond(`You're already in Nation ${user.nation_id} (${nation.name || "Unnamed"}) as a **${user.role}**!`);
      return;
    }

    const nations = getAllNations();
    let targetNation = null;
    let minMembers = Infinity;

    Object.values(nations).forEach((nation) => {
      const memberCount = nation.members.length;
      if (memberCount < minMembers) {
        minMembers = memberCount;
        targetNation = nation;
      }
    });

    if (!targetNation) {
      console.log(`[kal-join] No nations available`);
      await respond("Error: No nations available.");
      return;
    }

    console.log(`[kal-join] Assigning to nation ${targetNation.id}`);

    targetNation.members.push(userId);
    const isFirstMember = targetNation.members.length === 1;

    if (isFirstMember) {
      console.log(`[kal-join] User is first member, making president`);
      targetNation.president_id = userId;
      targetNation.cycle_start = new Date().toISOString();
      targetNation.cycle_day = 1;
      targetNation.term_start = new Date().toISOString();
      targetNation.president_terms = 1;
      targetNation.term_history = [{ user_id: userId, started_at: new Date().toISOString() }];
    }

    updateNation(targetNation.id, targetNation);

    updateUser(userId, {
      nation_id: targetNation.id,
      joined_date: new Date().toISOString(),
      role: isFirstMember ? "president" : "citizen",
    });

    const message = isFirstMember
      ? `🎉 Welcome to Nation ${targetNation.id}! You're the first member and are now **President**. Use \`/kal-actions\` to set up your government!`
      : `✅ Joined Nation ${targetNation.id}! You are a **Citizen**. Use \`/kal-actions\` to see available options.`;

    console.log(`[kal-join] Sending message`);
    await respond(message);
    console.log(`[kal-join] Message sent successfully`);
  } catch (error) {
    console.error("[kal-join] Error:", error);
    await respond("An error occurred while joining. Please try again.");
  }
});

// Helper function to calculate cycle day
function calculateCycleDay(cycleStart) {
  const now = new Date();
  const start = new Date(cycleStart);
  const daysPassed = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  return Math.min(daysPassed + 1, 14);
}

// Uncapped version — used to detect when a cycle has actually run past day 14
function calculateRawCycleDay(cycleStart) {
  const now = new Date();
  const start = new Date(cycleStart);
  const daysPassed = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  return daysPassed + 1;
}

// Resolves a finished election cycle: tallies votes, picks a winner (respecting
// term limits and ties), installs them as president, logs history, and resets
// the cycle for the next 14-day period. Safe to call repeatedly — only acts
// once per cycle thanks to the cycle_start reset.
function resolveCycleIfNeeded(nation) {
  const rawDay = calculateRawCycleDay(nation.cycle_start);
  if (rawDay <= 14) {
    return { resolved: false, nation };
  }

  const election = getElection(nation.id) || { applications: [], votes: {}, voters: {} };
  const votes = election.votes || {};
  const applications = election.applications || [];

  let winnerId = nation.president_id; // default: no winner, president stays
  let resultNote = "No candidates ran this cycle — the president remains in office.";

  if (applications.length > 0) {
    const eligibleApplicants = applications.filter((a) => isEligibleForPresident(a.user_id, nation));

    if (eligibleApplicants.length === 0) {
      resultNote = "All candidates were term-limited — the president remains in office.";
    } else {
      // Tally votes for eligible applicants only
      const tally = eligibleApplicants.map((a) => ({
        user_id: a.user_id,
        votes: votes[a.user_id] || 0,
      }));

      const maxVotes = Math.max(...tally.map((t) => t.votes));
      const topCandidates = tally.filter((t) => t.votes === maxVotes);

      if (topCandidates.length === 1) {
        winnerId = topCandidates[0].user_id;
        resultNote = `<@${winnerId}> won the election with ${maxVotes} vote(s)!`;
      } else {
        // Tie-breaking
        const currentPresidentInTie = topCandidates.find((t) => t.user_id === nation.president_id);

        if (!currentPresidentInTie) {
          // Current president breaks the tie — flagged for manual resolution
          return {
            resolved: false,
            nation,
            needsTieBreak: true,
            tiedCandidates: topCandidates.map((t) => t.user_id),
          };
        } else if (topCandidates.length === 2) {
          // President is tied with exactly one other — the other one wins
          winnerId = topCandidates.find((t) => t.user_id !== nation.president_id).user_id;
          resultNote = `It was a tie, but <@${winnerId}> wins as the incumbent steps aside!`;
        } else {
          // 3+ way tie including the president — pick randomly among the others
          const others = topCandidates.filter((t) => t.user_id !== nation.president_id);
          winnerId = others[Math.floor(Math.random() * others.length)].user_id;
          resultNote = `It was a multi-way tie! <@${winnerId}> won the random tiebreaker.`;
        }
      }
    }
  }

  const isNewPresident = winnerId !== nation.president_id;
  const termHistory = nation.term_history || [];

  if (winnerId) {
    termHistory.push({ user_id: winnerId, started_at: new Date().toISOString() });
  }

  const updatedNation = {
    ...nation,
    president_id: winnerId,
    president_terms: isNewPresident ? 1 : (nation.president_terms || 1) + 1,
    cycle_start: new Date().toISOString(),
    cycle_day: 1,
    term_start: new Date().toISOString(),
    term_history: termHistory,
    election_history: [
      ...(nation.election_history || []),
      {
        ended_at: new Date().toISOString(),
        winner_id: winnerId,
        applications: applications.map((a) => a.user_id),
        votes: votes,
        result_note: resultNote,
      },
    ],
  };

  updateNation(nation.id, updatedNation);
  updateElection(nation.id, { applications: [], votes: {}, voters: {} });

  if (isNewPresident && winnerId) {
    updateUser(winnerId, { role: "president" });
  }

  return { resolved: true, nation: updatedNation, resultNote, winnerId };
}

// /kal-actions command
app.command("/kal-actions", async ({ ack, body, client }) => {
  await ack();

  try {
    const userId = body.user_id;
    let user = getUser(userId);

    if (!user || !user.nation_id) {
      await client.chat.postMessage({
        channel: body.channel_id,
        text: "You're not in a nation yet! Use `/kal-join` to join.",
      });
      return;
    }

    let nation = getNation(user.nation_id);

    // Check if the election cycle has ended and needs resolving
    const resolution = resolveCycleIfNeeded(nation);
    if (resolution.needsTieBreak) {
      // Current president must break the tie; show them a picker instead of the normal menu
      if (userId === nation.president_id) {
        const tieBlocks = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*The election ended in a tie!* As the current president, you must choose the winner:`,
            },
          },
          {
            type: "actions",
            elements: resolution.tiedCandidates.map((candidateId) => ({
              type: "button",
              text: { type: "plain_text", text: `Choose ${candidateId}` },
              action_id: "tiebreak_btn",
              value: `${nation.id}:${candidateId}`,
            })),
          },
        ];
        await client.views.open({
          trigger_id: body.trigger_id,
          view: {
            type: "modal",
            callback_id: "tiebreak_modal",
            title: { type: "plain_text", text: "Break the Tie" },
            blocks: tieBlocks,
            close: { type: "plain_text", text: "Close" },
            private_metadata: JSON.stringify({ channel_id: body.channel_id }),
          },
        });
        return;
      } else {
        await client.chat.postMessage({
          channel: body.channel_id,
          text: "⏳ The election ended in a tie — waiting on the current president to break it.",
        });
        return;
      }
    }
    if (resolution.resolved) {
      await client.chat.postMessage({
        channel: body.channel_id,
        text: `🗳️ *Election Results:* ${resolution.resultNote}`,
      });
      nation = resolution.nation;
    }

    user = getUser(userId);
    const election = getElection(user.nation_id);
    const cycleDay = calculateCycleDay(nation.cycle_start);

    updateNation(nation.id, { cycle_day: cycleDay });

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Nation ${nation.id}: ${nation.name || "Unnamed"}*\nCycle Day: ${cycleDay}/14\nYour Role: ${user.role}`,
        },
      },
      {
        type: "divider",
      },
    ];

    // Days 1-10: Normal operations
    if (cycleDay >= 1 && cycleDay <= 10) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "*Regular Operations*" },
      });

      if (user.role === "president") {
        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Create Role" },
              action_id: "create_role_btn",
              value: String(nation.id),
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Appoint Member" },
              action_id: "appoint_member_btn",
              value: String(nation.id),
            },
          ],
        });
      }

      // Everyone gets these
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Work (Earn Resources)" },
            action_id: "work_btn",
            value: String(nation.id),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "View Nation Stats" },
            action_id: "view_stats_btn",
            value: String(nation.id),
          },
        ],
      });

      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Explore" },
            action_id: "explore_btn",
            value: String(nation.id),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Train" },
            action_id: "train_btn",
            value: String(nation.id),
          },
        ],
      });

      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Donate to Nation" },
            action_id: "donate_btn",
            value: String(nation.id),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "View Market Prices" },
            action_id: "market_btn",
            value: String(nation.id),
          },
        ],
      });

      // Economic-perms only: Trade, Buy, Sell
      if (hasEconomicPerms(user, nation)) {
        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Trade Resources" },
              action_id: "trade_btn",
              value: String(nation.id),
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Buy Items" },
              action_id: "buy_btn",
              value: String(nation.id),
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Sell Items" },
              action_id: "sell_btn",
              value: String(nation.id),
            },
          ],
        });
      }

      // Military-perms only: Declare War
      if (hasMilitaryPerms(user, nation)) {
        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Declare War" },
              action_id: "declare_war_btn",
              value: String(nation.id),
            },
          ],
        });
      }
    }

    // Days 11-12: Applications open
    if (cycleDay >= 11 && cycleDay <= 12) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "*Election Phase 1: Applications (Days 11-12)*" },
      });

      const hasApplied = election.applications.some(
        (app) => app.user_id === userId
      );
      const eligible = isEligibleForPresident(userId, nation);

      if (!hasApplied && eligible) {
        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Apply for President" },
              action_id: "apply_president_btn",
              value: String(nation.id),
            },
          ],
        });
      } else if (hasApplied) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: "✅ You've already applied for President" },
        });
      } else if (!eligible) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: "🚫 You've served the max 2 terms in the last 3 months — not eligible this cycle." },
        });
      }

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Current Candidates:* ${
            election.applications.length > 0
              ? election.applications.map((a) => `<@${a.user_id}>`).join(", ")
              : "None yet"
          }`,
        },
      });
    }

    // Days 13-14: Voting
    if (cycleDay >= 13 && cycleDay <= 14) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "*Election Phase 2: Voting (Days 13-14)*" },
      });

      const alreadyVotedFor = election.voters?.[userId];

      if (alreadyVotedFor) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `✅ Your vote is locked in for <@${alreadyVotedFor}>.` },
        });
      } else if (election.applications.length > 0) {
        const votingElements = election.applications.map((candidate) => ({
          type: "button",
          text: { type: "plain_text", text: `Vote for ${candidate.user_id}` },
          action_id: "vote_btn",
          value: `${nation.id}:${candidate.user_id}`,
        }));

        blocks.push({
          type: "actions",
          elements: votingElements.slice(0, 5),
        });

        if (votingElements.length > 5) {
          blocks.push({
            type: "actions",
            elements: votingElements.slice(5, 10),
          });
        }
      } else {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: "No candidates this cycle." },
        });
      }
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "kal_actions_modal",
        title: { type: "plain_text", text: "Nation Actions" },
        blocks: blocks,
        close: { type: "plain_text", text: "Close" },
        private_metadata: JSON.stringify({ channel_id: body.channel_id }),
      },
    });
  } catch (error) {
    console.error("[kal-actions] Error:", error);
  }
});

// Handle "Apply for President" button
app.action("apply_president_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    const userId = body.user.id;
    const nationId = body.actions[0].value;
    const nation = getNation(nationId);
    const election = getElection(nationId) || { applications: [], votes: {}, voters: {} };
    const channelId = JSON.parse(body.view.private_metadata).channel_id;

    if (!isEligibleForPresident(userId, nation)) {
      await client.chat.postMessage({
        channel: channelId,
        text: `❌ <@${userId}>, you've already served the maximum of 2 terms within the last 3 months. You're not eligible to run this cycle.`,
      });
      return;
    }

    if (!election.applications.some((a) => a.user_id === userId)) {
      election.applications.push({
        user_id: userId,
        applied_day: calculateCycleDay(nation.cycle_start),
      });
      updateElection(nationId, election);

      await client.chat.postMessage({
        channel: channelId,
        text: `✅ <@${userId}> has applied to be President!`,
      });
    }
  } catch (error) {
    console.error("[apply_president_btn] Error:", error);
  }
});

// Handle "Vote" button
app.action("vote_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    const userId = body.user.id;
    const [nationId, candidateId] = body.actions[0].value.split(":");
    const election = getElection(nationId) || { applications: [], votes: {}, voters: {} };
    const channelId = JSON.parse(body.view.private_metadata).channel_id;

    if (!election.votes) election.votes = {};
    if (!election.voters) election.voters = {};

    if (election.voters[userId]) {
      await client.chat.postMessage({
        channel: channelId,
        text: `❌ <@${userId}>, your vote is already locked in for <@${election.voters[userId]}>. You can't change it.`,
      });
      return;
    }

    election.votes[candidateId] = (election.votes[candidateId] || 0) + 1;
    election.voters[userId] = candidateId;
    updateElection(nationId, election);

    await client.chat.postMessage({
      channel: channelId,
      text: `✅ <@${userId}> voted for <@${candidateId}>!`,
    });
  } catch (error) {
    console.error("[vote_btn] Error:", error);
  }
});

// Handle the current president breaking an election tie
app.action("tiebreak_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    const [nationId, chosenWinnerId] = body.actions[0].value.split(":");
    const nation = getNation(nationId);
    const channelId = JSON.parse(body.view.private_metadata).channel_id;

    if (body.user.id !== nation.president_id) {
      await client.chat.postMessage({
        channel: channelId,
        text: `❌ Only the current president can break this tie.`,
      });
      return;
    }

    const termHistory = nation.term_history || [];
    termHistory.push({ user_id: chosenWinnerId, started_at: new Date().toISOString() });
    const isNewPresident = chosenWinnerId !== nation.president_id;

    const election = getElection(nationId) || { applications: [], votes: {} };

    const updatedNation = {
      ...nation,
      president_id: chosenWinnerId,
      president_terms: isNewPresident ? 1 : (nation.president_terms || 1) + 1,
      cycle_start: new Date().toISOString(),
      cycle_day: 1,
      term_start: new Date().toISOString(),
      term_history: termHistory,
      election_history: [
        ...(nation.election_history || []),
        {
          ended_at: new Date().toISOString(),
          winner_id: chosenWinnerId,
          applications: (election.applications || []).map((a) => a.user_id),
          votes: election.votes || {},
          result_note: `Tie broken by the incumbent president — <@${chosenWinnerId}> wins.`,
        },
      ],
    };

    updateNation(nationId, updatedNation);
    updateElection(nationId, { applications: [], votes: {}, voters: {} });

    if (isNewPresident) {
      updateUser(chosenWinnerId, { role: "president" });
    }

    await client.chat.postMessage({
      channel: channelId,
      text: `🗳️ The tie has been broken! <@${chosenWinnerId}> is the new president.`,
    });
  } catch (error) {
    console.error("[tiebreak_btn] Error:", error);
  }
});

// Handle "Create Role" button
app.action("create_role_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "create_role_modal",
        title: { type: "plain_text", text: "Create Role" },
        blocks: [
          {
            type: "input",
            block_id: "role_name_block",
            label: { type: "plain_text", text: "Role Name" },
            element: {
              type: "plain_text_input",
              action_id: "role_name_input",
              placeholder: { type: "plain_text", text: "e.g., Minister of Economics" },
            },
          },
          {
            type: "input",
            block_id: "role_permissions_block",
            label: { type: "plain_text", text: "Permissions" },
            optional: true,
            element: {
              type: "multi_static_select",
              action_id: "role_permissions_input",
              placeholder: { type: "plain_text", text: "Select permissions (optional)" },
              options: [
                {
                  text: { type: "plain_text", text: "Economic (Trade, Buy, Sell)" },
                  value: "economic",
                },
                {
                  text: { type: "plain_text", text: "Military (Declare War)" },
                  value: "military",
                },
              ],
            },
          },
        ],
        submit: { type: "plain_text", text: "Create" },
        private_metadata: body.view.private_metadata,
      },
    });
  } catch (error) {
    console.error("[create_role_btn] Error:", error);
  }
});

// Handle "Appoint Member" button
app.action("appoint_member_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    const user = getUser(body.user.id);
    const nation = getNation(user.nation_id);
    const roleOptions = Object.entries(nation.roles || {}).map(([key, role]) => ({
      text: { type: "plain_text", text: role.name },
      value: key,
    }));

    if (roleOptions.length === 0) {
      await client.chat.postMessage({
        channel: JSON.parse(body.view.private_metadata).channel_id,
        text: "❌ No custom roles exist yet. Use Create Role first.",
      });
      return;
    }

    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "appoint_member_modal",
        title: { type: "plain_text", text: "Appoint Member" },
        blocks: [
          {
            type: "input",
            block_id: "appoint_user_block",
            label: { type: "plain_text", text: "Member" },
            element: {
              type: "users_select",
              action_id: "appoint_user_input",
              placeholder: { type: "plain_text", text: "Select a member" },
            },
          },
          {
            type: "input",
            block_id: "appoint_role_block",
            label: { type: "plain_text", text: "Role" },
            element: {
              type: "static_select",
              action_id: "appoint_role_input",
              placeholder: { type: "plain_text", text: "Select a role" },
              options: roleOptions,
            },
          },
        ],
        submit: { type: "plain_text", text: "Appoint" },
        private_metadata: body.view.private_metadata,
      },
    });
  } catch (error) {
    console.error("[appoint_member_btn] Error:", error);
  }
});

// Handle Appoint Member modal submission
app.view("appoint_member_modal", async ({ ack, body, view, client }) => {
  await ack();

  try {
    const appointerId = body.user.id;
    const appointer = getUser(appointerId);
    const nation = getNation(appointer.nation_id);
    const targetUserId = view.state.values.appoint_user_block.appoint_user_input.selected_user;
    const roleKey = view.state.values.appoint_role_block.appoint_role_input.selected_option.value;

    nation.roles = nation.roles || {};
    if (!nation.roles[roleKey]) {
      await client.chat.postMessage({
        channel: JSON.parse(body.view.private_metadata).channel_id,
        text: "❌ That role no longer exists.",
      });
      return;
    }

    nation.roles[roleKey].user_id = targetUserId;
    updateNation(nation.id, nation);
    updateUser(targetUserId, { role: roleKey });

    await client.chat.postMessage({
      channel: JSON.parse(body.view.private_metadata).channel_id,
      text: `✅ <@${targetUserId}> appointed as *${nation.roles[roleKey].name}*!`,
    });
  } catch (error) {
    console.error("[appoint_member_modal] Error:", error);
  }
});
app.view("create_role_modal", async ({ ack, body, view, client }) => {
  await ack();

  try {
    const userId = body.user.id;
    const roleName = view.state.values.role_name_block.role_name_input.value;
    const selectedPerms = view.state.values.role_permissions_block.role_permissions_input.selected_options || [];
    const permissions = selectedPerms.map((opt) => opt.value);
    const user = getUser(userId);
    const nation = getNation(user.nation_id);

    const roleKey = roleName.toLowerCase().replace(/\s+/g, "_");
    nation.roles = nation.roles || {};
    nation.roles[roleKey] = {
      name: roleName,
      user_id: null,
      custom: true,
      permissions: permissions,
    };

    updateNation(nation.id, nation);

    const permsText = permissions.length > 0 ? ` (Permissions: ${permissions.join(", ")})` : "";
    await client.chat.postMessage({
      channel: JSON.parse(body.view.private_metadata).channel_id,
      text: `✅ New role created: *${roleName}*${permsText}`,
    });
  } catch (error) {
    console.error("[create_role_modal] Error:", error);
  }
});

// Handle "Work" button
app.action("work_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    const user = getUser(body.user.id);
    const nation = getNation(user.nation_id);
    const channelId = JSON.parse(body.view.private_metadata).channel_id;

    const WORK_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
    const remaining = getCooldownRemaining(user, "work", WORK_COOLDOWN_MS);
    if (remaining > 0) {
      await client.chat.postMessage({
        channel: channelId,
        text: `⏳ <@${body.user.id}>, you need to rest! Work again in ${formatCooldown(remaining)}.`,
      });
      return;
    }

    // Random resource gain (10-30)
    const gain = Math.floor(Math.random() * 20) + 10;
    const resources = ["food", "wood", "gold", "ore"];
    const randomResource = resources[Math.floor(Math.random() * resources.length)];

    nation.resources[randomResource] += gain;
    updateNation(nation.id, nation);

    updateUser(body.user.id, {
      cooldowns: { ...user.cooldowns, work: new Date().toISOString() },
    });

    await client.chat.postMessage({
      channel: channelId,
      text: `🔨 <@${body.user.id}> worked hard! Gained ${gain} ${randomResource} for the nation!`,
    });
  } catch (error) {
    console.error("[work_btn] Error:", error);
  }
});

// Handle "Explore" button
app.action("explore_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    const user = getUser(body.user.id);
    const channelId = JSON.parse(body.view.private_metadata).channel_id;

    const EXPLORE_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes
    const remaining = getCooldownRemaining(user, "explore", EXPLORE_COOLDOWN_MS);
    if (remaining > 0) {
      await client.chat.postMessage({
        channel: channelId,
        text: `⏳ <@${body.user.id}>, you're still recovering from your last trip. Explore again in ${formatCooldown(remaining)}.`,
      });
      return;
    }

    const personal = { ...user.personal_resources };
    const roll = Math.random();
    let outcomeText;

    if (roll < 0.45) {
      // Find loot
      const resources = ["food", "wood", "gold", "ore"];
      const found = resources[Math.floor(Math.random() * resources.length)];
      const amount = Math.floor(Math.random() * 15) + 5;
      personal[found] = (personal[found] || 0) + amount;
      outcomeText = `🧭 <@${body.user.id}> explored and found ${amount} ${found}!`;
    } else if (roll < 0.8) {
      // Nothing happens
      outcomeText = `🧭 <@${body.user.id}> explored but found nothing of note.`;
    } else {
      // Hostile encounter — lose a small amount of a random personal resource
      const heldResources = Object.entries(personal).filter(([, amt]) => amt > 0);
      if (heldResources.length > 0) {
        const [lostKey] = heldResources[Math.floor(Math.random() * heldResources.length)];
        const lossAmount = Math.min(personal[lostKey], Math.floor(Math.random() * 10) + 1);
        personal[lostKey] -= lossAmount;
        outcomeText = `⚔️ <@${body.user.id}> was ambushed while exploring and lost ${lossAmount} ${lostKey}!`;
      } else {
        outcomeText = `⚔️ <@${body.user.id}> was ambushed while exploring, but had nothing worth taking.`;
      }
    }

    updateUser(body.user.id, {
      personal_resources: personal,
      cooldowns: { ...user.cooldowns, explore: new Date().toISOString() },
    });

    await client.chat.postMessage({ channel: channelId, text: outcomeText });
  } catch (error) {
    console.error("[explore_btn] Error:", error);
  }
});

// Handle "Train" button
app.action("train_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    const user = getUser(body.user.id);
    const channelId = JSON.parse(body.view.private_metadata).channel_id;

    const TRAIN_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes
    const remaining = getCooldownRemaining(user, "train", TRAIN_COOLDOWN_MS);
    if (remaining > 0) {
      await client.chat.postMessage({
        channel: channelId,
        text: `⏳ <@${body.user.id}>, you're still tired from training. Train again in ${formatCooldown(remaining)}.`,
      });
      return;
    }

    const gain = Math.floor(Math.random() * 4) + 1;
    const currentStats = user.stats || { influence: 0 };
    const newInfluence = (currentStats.influence || 0) + gain;

    updateUser(body.user.id, {
      stats: { ...currentStats, influence: newInfluence },
      cooldowns: { ...user.cooldowns, train: new Date().toISOString() },
    });

    await client.chat.postMessage({
      channel: channelId,
      text: `💪 <@${body.user.id}> trained hard and gained ${gain} Influence! (Total: ${newInfluence})`,
    });
  } catch (error) {
    console.error("[train_btn] Error:", error);
  }
});

// Handle "View Stats" button
app.action("view_stats_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    const user = getUser(body.user.id);
    const nation = getNation(user.nation_id);
    const personal = user.personal_resources || { food: 0, wood: 0, gold: 0, ore: 0 };
    const influence = user.stats?.influence || 0;

    const stats = `
*Nation Stats:*
Area: ${nation.area}
Population: ${nation.population}
Resources:
  • Food: ${nation.resources.food}
  • Wood: ${nation.resources.wood}
  • Gold: ${nation.resources.gold}
  • Ore: ${nation.resources.ore}
President: <@${nation.president_id}>
Members: ${nation.members.length}

*Your Stats:*
Influence: ${influence}
Your Personal Resources:
  • Food: ${personal.food || 0}
  • Wood: ${personal.wood || 0}
  • Gold: ${personal.gold || 0}
  • Ore: ${personal.ore || 0}
    `;

    await client.chat.postMessage({
      channel: JSON.parse(body.view.private_metadata).channel_id,
      text: stats,
    });
  } catch (error) {
    console.error("[view_stats_btn] Error:", error);
  }
});

// Handle "Donate to Nation" button
app.action("donate_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    const user = getUser(body.user.id);
    const personal = user.personal_resources || { food: 0, wood: 0, gold: 0, ore: 0 };
    const resourceOptions = ["food", "wood", "gold", "ore"]
      .filter((key) => (personal[key] || 0) > 0)
      .map((key) => ({
        text: { type: "plain_text", text: `${key} (you have ${personal[key]})` },
        value: key,
      }));

    if (resourceOptions.length === 0) {
      await client.chat.postMessage({
        channel: JSON.parse(body.view.private_metadata).channel_id,
        text: `❌ <@${body.user.id}>, you don't have any personal resources to donate. Try Work or Explore first!`,
      });
      return;
    }

    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "donate_modal",
        title: { type: "plain_text", text: "Donate to Nation" },
        blocks: [
          {
            type: "input",
            block_id: "donate_resource_block",
            label: { type: "plain_text", text: "Resource" },
            element: {
              type: "static_select",
              action_id: "donate_resource_input",
              placeholder: { type: "plain_text", text: "Select a resource" },
              options: resourceOptions,
            },
          },
          {
            type: "input",
            block_id: "donate_amount_block",
            label: { type: "plain_text", text: "Amount" },
            element: {
              type: "plain_text_input",
              action_id: "donate_amount_input",
              placeholder: { type: "plain_text", text: "e.g., 10" },
            },
          },
        ],
        submit: { type: "plain_text", text: "Donate" },
        private_metadata: body.view.private_metadata,
      },
    });
  } catch (error) {
    console.error("[donate_btn] Error:", error);
  }
});

// Handle Donate modal submission
app.view("donate_modal", async ({ ack, body, view, client }) => {
  try {
    const userId = body.user.id;
    const user = getUser(userId);
    const resourceKey = view.state.values.donate_resource_block.donate_resource_input.selected_option.value;
    const amount = parseInt(view.state.values.donate_amount_block.donate_amount_input.value);
    const channelId = JSON.parse(body.view.private_metadata).channel_id;

    const personal = user.personal_resources || { food: 0, wood: 0, gold: 0, ore: 0 };

    if (!amount || amount <= 0) {
      await ack({
        response_action: "errors",
        errors: { donate_amount_block: "Enter a valid positive number." },
      });
      return;
    }

    if ((personal[resourceKey] || 0) < amount) {
      await ack({
        response_action: "errors",
        errors: { donate_amount_block: `You only have ${personal[resourceKey] || 0} ${resourceKey}.` },
      });
      return;
    }

    await ack();

    personal[resourceKey] -= amount;
    updateUser(userId, { personal_resources: personal });

    const nation = getNation(user.nation_id);
    nation.resources[resourceKey] = (nation.resources[resourceKey] || 0) + amount;
    updateNation(nation.id, nation);

    await client.chat.postMessage({
      channel: channelId,
      text: `🎁 <@${userId}> donated ${amount} ${resourceKey} to the nation!`,
    });
  } catch (error) {
    console.error("[donate_modal] Error:", error);
  }
});

// Handle "Trade Resources" button
app.action("trade_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "trade_modal",
        title: { type: "plain_text", text: "Propose Trade" },
        blocks: [
          {
            type: "input",
            block_id: "target_nation_block",
            label: { type: "plain_text", text: "Target Nation ID" },
            element: {
              type: "plain_text_input",
              action_id: "target_nation_input",
              placeholder: { type: "plain_text", text: "e.g., 2" },
            },
          },
          {
            type: "input",
            block_id: "offering_block",
            label: { type: "plain_text", text: "Resource You're Offering" },
            element: {
              type: "plain_text_input",
              action_id: "offering_input",
              placeholder: { type: "plain_text", text: "e.g., food" },
            },
          },
          {
            type: "input",
            block_id: "amount_block",
            label: { type: "plain_text", text: "Amount" },
            element: {
              type: "plain_text_input",
              action_id: "amount_input",
              placeholder: { type: "plain_text", text: "e.g., 50" },
            },
          },
          {
            type: "input",
            block_id: "requesting_block",
            label: { type: "plain_text", text: "Resource You Want" },
            element: {
              type: "plain_text_input",
              action_id: "requesting_input",
              placeholder: { type: "plain_text", text: "e.g., ore" },
            },
          },
        ],
        submit: { type: "plain_text", text: "Propose Trade" },
        private_metadata: body.view.private_metadata,
      },
    });
  } catch (error) {
    console.error("[trade_btn] Error:", error);
  }
});

// Handle Trade modal submission
app.view("trade_modal", async ({ ack, body, view, client }) => {
  await ack();

  try {
    const userId = body.user.id;
    const user = getUser(userId);
    const targetNationId = view.state.values.target_nation_block.target_nation_input.value;
    const offering = view.state.values.offering_block.offering_input.value;
    const amount = parseInt(view.state.values.amount_block.amount_input.value);
    const requesting = view.state.values.requesting_block.requesting_input.value;

    const nation = getNation(user.nation_id);

    if (nation.resources[offering] < amount) {
      await client.chat.postMessage({
        channel: JSON.parse(body.view.private_metadata).channel_id,
        text: `❌ You don't have enough ${offering}! You have ${nation.resources[offering]}.`,
      });
      return;
    }

    createTrade(user.nation_id, targetNationId, offering, requesting, amount);

    await client.chat.postMessage({
      channel: JSON.parse(body.view.private_metadata).channel_id,
      text: `✅ Trade proposed! Offering ${amount} ${offering} to Nation ${targetNationId} for ${requesting}.`,
    });
  } catch (error) {
    console.error("[trade_modal] Error:", error);
  }
});

// Handle "Buy Items" button
app.action("buy_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    const items = getAllItems();
    const itemList = Object.entries(items).map(([key, item]) => ({
      text: { type: "mrkdwn", text: `*${item.name}*\nPrice: ${item.current_value} gold` },
      value: key,
    }));

    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "buy_modal",
        title: { type: "plain_text", text: "Buy Items" },
        blocks: [
          {
            type: "input",
            block_id: "item_block",
            label: { type: "plain_text", text: "Select Item" },
            element: {
              type: "plain_text_input",
              action_id: "item_input",
              placeholder: { type: "plain_text", text: "e.g., fish" },
            },
          },
          {
            type: "input",
            block_id: "quantity_block",
            label: { type: "plain_text", text: "Quantity" },
            element: {
              type: "plain_text_input",
              action_id: "quantity_input",
              placeholder: { type: "plain_text", text: "e.g., 10" },
            },
          },
        ],
        submit: { type: "plain_text", text: "Buy" },
        private_metadata: body.view.private_metadata,
      },
    });
  } catch (error) {
    console.error("[buy_btn] Error:", error);
  }
});

// Handle Buy modal submission
app.view("buy_modal", async ({ ack, body, view, client }) => {
  await ack();

  try {
    const userId = body.user.id;
    const user = getUser(userId);
    const nation = getNation(user.nation_id);
    const itemKey = view.state.values.item_block.item_input.value;
    const quantity = parseInt(view.state.values.quantity_block.quantity_input.value);

    const item = getItem(itemKey);
    if (!item) {
      await client.chat.postMessage({
        channel: JSON.parse(body.view.private_metadata).channel_id,
        text: `❌ Item not found!`,
      });
      return;
    }

    const totalCost = item.current_value * quantity;

    if (nation.resources.gold < totalCost) {
      await client.chat.postMessage({
        channel: JSON.parse(body.view.private_metadata).channel_id,
        text: `❌ Not enough gold! Need ${totalCost}, have ${nation.resources.gold}.`,
      });
      return;
    }

    nation.resources.gold -= totalCost;
    updateNation(nation.id, nation);

    await client.chat.postMessage({
      channel: JSON.parse(body.view.private_metadata).channel_id,
      text: `✅ Purchased ${quantity} ${item.name} for ${totalCost} gold!`,
    });
  } catch (error) {
    console.error("[buy_modal] Error:", error);
  }
});

// Handle "Sell Items" button
app.action("sell_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "sell_modal",
        title: { type: "plain_text", text: "Sell Items" },
        blocks: [
          {
            type: "input",
            block_id: "sell_item_block",
            label: { type: "plain_text", text: "Item to Sell" },
            element: {
              type: "plain_text_input",
              action_id: "sell_item_input",
              placeholder: { type: "plain_text", text: "e.g., food" },
            },
          },
          {
            type: "input",
            block_id: "sell_quantity_block",
            label: { type: "plain_text", text: "Quantity" },
            element: {
              type: "plain_text_input",
              action_id: "sell_quantity_input",
              placeholder: { type: "plain_text", text: "e.g., 50" },
            },
          },
        ],
        submit: { type: "plain_text", text: "Sell" },
        private_metadata: body.view.private_metadata,
      },
    });
  } catch (error) {
    console.error("[sell_btn] Error:", error);
  }
});

// Handle Sell modal submission
app.view("sell_modal", async ({ ack, body, view, client }) => {
  await ack();

  try {
    const userId = body.user.id;
    const user = getUser(userId);
    const nation = getNation(user.nation_id);
    const itemKey = view.state.values.sell_item_block.sell_item_input.value;
    const quantity = parseInt(view.state.values.sell_quantity_block.sell_quantity_input.value);

    const item = getItem(itemKey);
    if (!item) {
      await client.chat.postMessage({
        channel: JSON.parse(body.view.private_metadata).channel_id,
        text: `❌ Item not found!`,
      });
      return;
    }

    if (nation.resources[itemKey] < quantity) {
      await client.chat.postMessage({
        channel: JSON.parse(body.view.private_metadata).channel_id,
        text: `❌ You don't have enough ${item.name}! You have ${nation.resources[itemKey]}.`,
      });
      return;
    }

    const totalGain = item.current_value * quantity;
    nation.resources[itemKey] -= quantity;
    nation.resources.gold += totalGain;
    updateNation(nation.id, nation);

    await client.chat.postMessage({
      channel: JSON.parse(body.view.private_metadata).channel_id,
      text: `✅ Sold ${quantity} ${item.name} for ${totalGain} gold!`,
    });
  } catch (error) {
    console.error("[sell_modal] Error:", error);
  }
});

// Handle "View Market Prices" button
app.action("market_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    const items = getAllItems();
    let marketText = "*📊 Market Prices:*\n\n";

    Object.entries(items).forEach(([key, item]) => {
      marketText += `*${item.name}*: ${item.current_value} gold (Rarity: ${item.rarity})\n`;
    });

    await client.chat.postMessage({
      channel: JSON.parse(body.view.private_metadata).channel_id,
      text: marketText,
    });
  } catch (error) {
    console.error("[market_btn] Error:", error);
  }
});

// Handle "Declare War" button
app.action("declare_war_btn", async ({ ack, body, client }) => {
  await ack();

  try {
    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "declare_war_modal",
        title: { type: "plain_text", text: "Declare War" },
        blocks: [
          {
            type: "input",
            block_id: "enemy_nation_block",
            label: { type: "plain_text", text: "Enemy Nation ID" },
            element: {
              type: "plain_text_input",
              action_id: "enemy_nation_input",
              placeholder: { type: "plain_text", text: "e.g., 3" },
            },
          },
        ],
        submit: { type: "plain_text", text: "Declare War" },
        private_metadata: body.view.private_metadata,
      },
    });
  } catch (error) {
    console.error("[declare_war_btn] Error:", error);
  }
});

// Handle Declare War modal submission
app.view("declare_war_modal", async ({ ack, body, view, client }) => {
  await ack();

  try {
    const userId = body.user.id;
    const user = getUser(userId);
    const enemyNationId = view.state.values.enemy_nation_block.enemy_nation_input.value;

    declareWar(user.nation_id, enemyNationId);

    await client.chat.postMessage({
      channel: JSON.parse(body.view.private_metadata).channel_id,
      text: `⚔️ War declared against Nation ${enemyNationId}!`,
    });
  } catch (error) {
    console.error("[declare_war_modal] Error:", error);
  }
});

// TEMP DIAGNOSTIC — catches anything Bolt would otherwise swallow silently
app.error(async (error) => {
  console.error("[BOLT GLOBAL ERROR]", error);
});

// Start the bot
(async () => {
  await app.start();
  console.log("bot is running");
})();