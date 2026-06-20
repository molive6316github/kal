const fs = require("fs");
const path = require("path");

const dataDir = __dirname;

// Helper functions to read/write each file
function readFile(filename) {
  const filePath = path.join(dataDir, filename);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeFile(filename, data) {
  const filePath = path.join(dataDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// NATIONS
function getNation(nationId) {
  const nations = readFile("nations.json");
  return nations[nationId];
}

function getAllNations() {
  return readFile("nations.json");
}

function updateNation(nationId, updates) {
  const nations = readFile("nations.json");
  nations[nationId] = { ...nations[nationId], ...updates };
  writeFile("nations.json", nations);
}

// USERS
function getUser(userId) {
  const users = readFile("users.json");
  return users[userId];
}

function getAllUsers() {
  return readFile("users.json");
}

function createUser(userId, username) {
  const users = readFile("users.json");
  users[userId] = {
    user_id: userId,
    username: username,
    nation_id: null,
    role: null,
    admin: false,
    joined_date: null,
    // Personal resources, separate from the nationwide pool
    personal_resources: {
      food: 0,
      wood: 0,
      gold: 0,
      ore: 0,
    },
    // Personal stats raised by Train
    stats: {
      influence: 0,
    },
    // Cooldown timestamps (ISO strings) keyed by action name
    cooldowns: {
      work: null,
      explore: null,
      train: null,
    },
  };
  writeFile("users.json", users);
}

function updateUser(userId, updates) {
  const users = readFile("users.json");
  users[userId] = { ...users[userId], ...updates };
  writeFile("users.json", users);
}

// ELECTIONS
function getElection(nationId) {
  const elections = readFile("elections.json");
  return elections[nationId] || { applications: [], votes: {}, voters: {} };
}

function updateElection(nationId, updates) {
  const elections = readFile("elections.json");
  elections[nationId] = { ...elections[nationId], ...updates };
  writeFile("elections.json", elections);
}

// ITEMS
function getItem(itemKey) {
  const items = readFile("items.json");
  return items[itemKey];
}

function getAllItems() {
  return readFile("items.json");
}

// ROLES
function getRoles() {
  return readFile("roles.json");
}

// TRADES
function getTrades(nationId) {
  const trades = readFile("trades.json");
  return trades[nationId] || [];
}

function createTrade(fromNationId, toNationId, offering, requesting, amount) {
  const trades = readFile("trades.json");
  if (!trades[fromNationId]) trades[fromNationId] = [];

  trades[fromNationId].push({
    id: Date.now(),
    from: fromNationId,
    to: toNationId,
    offering: offering,
    requesting: requesting,
    amount: amount,
    status: "pending",
    created_at: new Date().toISOString(),
  });

  writeFile("trades.json", trades);
}

function acceptTrade(nationId, tradeId) {
  const trades = readFile("trades.json");
  const trade = trades[nationId]?.find((t) => t.id === tradeId);
  if (trade) {
    trade.status = "accepted";
  }
  writeFile("trades.json", trades);
}

function rejectTrade(nationId, tradeId) {
  const trades = readFile("trades.json");
  if (trades[nationId]) {
    trades[nationId] = trades[nationId].filter((t) => t.id !== tradeId);
  }
  writeFile("trades.json", trades);
}

// WARS
function getWars(nationId) {
  const wars = readFile("wars.json");
  return wars[nationId] || [];
}

function declareWar(attackerNationId, defenderNationId) {
  const wars = readFile("wars.json");
  if (!wars[attackerNationId]) wars[attackerNationId] = [];

  wars[attackerNationId].push({
    id: Date.now(),
    attacker: attackerNationId,
    defender: defenderNationId,
    status: "ongoing",
    started_at: new Date().toISOString(),
    attacker_losses: 0,
    defender_losses: 0,
  });

  writeFile("wars.json", wars);
}

function endWar(nationId, warId, winner) {
  const wars = readFile("wars.json");
  const war = wars[nationId]?.find((w) => w.id === warId);
  if (war) {
    war.status = "ended";
    war.winner = winner;
    war.ended_at = new Date().toISOString();
  }
  writeFile("wars.json", wars);
}

module.exports = {
  readFile,
  writeFile,
  getNation,
  getAllNations,
  updateNation,
  getUser,
  getAllUsers,
  createUser,
  updateUser,
  getElection,
  updateElection,
  getItem,
  getAllItems,
  getRoles,
  getTrades,
  createTrade,
  acceptTrade,
  rejectTrade,
  getWars,
  declareWar,
  endWar,
};