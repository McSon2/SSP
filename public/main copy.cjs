const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const https = require("https");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const { pathToFileURL } = require("url");

let query, variables, ReloadSlots, originalSlotQueries;

async function initializeModules() {
  try {
    const queriesModule = await import("../src/queries/queries.mjs");
    query = queriesModule.query;
    variables = queriesModule.variables;

    const ReloadSlotsModule = await import("../src/js/ReloadSlots.mjs");
    ReloadSlots = ReloadSlotsModule.default || ReloadSlotsModule;

    // Chargement dynamique des queries pour les slots originaux
    const originalSlotQueriesModule = await import(
      "../src/queries/originalSlotQueries.mjs"
    );
    originalSlotQueries =
      originalSlotQueriesModule.default || originalSlotQueriesModule;

    console.log("Modules initialized successfully");
  } catch (error) {
    console.error("Error initializing modules:", error);
  }
}

let mainWindow;
let userAgent = "";
let allCookies = "";
let slotsClient = null;
let reloadSlotsInstance;

async function createWindow() {
  await initializeModules();
  const windowOptions = {
    width: 1600,
    height: 1000,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      enableRemoteModule: false,
      nodeIntegration: false,
    },
  };

  if (app.isPackaged) {
    windowOptions.autoHideMenuBar = true;
  }

  mainWindow = new BrowserWindow(windowOptions);

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  } else {
    mainWindow.loadURL("http://localhost:5173");
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  //mainWindow.webContents.openDevTools();

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  ["log", "error", "warn", "info"].forEach((method) => {
    const originalMethod = console[method];
    console[method] = (...args) => {
      originalMethod(...args);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("log", {
          type: method,
          message: args.join(" "),
        });
      }
    };
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    await databaseManager.close();
    app.quit();
  }
});

process.on("uncaughtException", (error) => {
  console.error("Erreur non capturée:", error);
});

const client = {
  getApiKey: () => {
    const configPath = path.join(app.getPath("userData"), "config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return config.apiKey;
    }
    return null;
  },
  getUserAgent: () => userAgent,
  getAllCookies: () => allCookies,
};

ipcMain.handle("get-config-path", () => {
  return path.join(app.getPath("userData"), "config.json");
});

ipcMain.handle("file-exists", (event, filePath) => {
  return fs.existsSync(filePath);
});

ipcMain.handle("read-file", (event, filePath, encoding) => {
  return fs.readFileSync(filePath, encoding);
});

ipcMain.handle("get-slots-path", () => {
  return path.join(app.getPath("userData"), "slots.csv");
});

ipcMain.handle("get-slots-data", async () => {
  const filePath = path.join(app.getPath("userData"), "slots.csv");
  if (fs.existsSync(filePath)) {
    const fileContent = fs.readFileSync(filePath, "utf8");
    const csvString = fileContent.toString("utf8");
    const slotsData = csvString
      .split("\n")
      .slice(1)
      .map((row) => {
        const [id, name, slug, thumbnailUrl, provider] = row.split(";");
        return { id, name, slug, thumbnailUrl, provider };
      });

    return slotsData;
  } else {
    throw new Error("File does not exist");
  }
});

ipcMain.on("login", (event, apiKey) => {
  const configPath = path.join(app.getPath("userData"), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ apiKey }));
});

ipcMain.on("start-client", (event, apiKey) => {
  slotsClient = new SlotsClient(
    "stake.bet",
    client.getUserAgent(),
    client.getAllCookies(),
    apiKey,
    path.join(app.getPath("userData"), "config.json")
  );
  slotsClient.startClient();

  // Envoyer un message à Renderer process pour naviguer
  mainWindow.webContents.send("navigate", "/selection");

  // Créez une instance de ReloadSlots ici après la définition de userAgent et allCookies
  reloadSlotsInstance = new ReloadSlots(
    "stake.bet",
    client.getUserAgent(),
    client.getAllCookies(),
    client.getApiKey(),
    path.join(app.getPath("userData"), "config.json")
  );
});

ipcMain.on("open-browser", async (event) => {
  try {
    await openLoginWindow();
    event.sender.send("cookies-retrieved");
  } catch (err) {
    console.error("Login failed:", err);
  }
});

ipcMain.handle("reload-slots", async (event) => {
  try {
    await reloadSlotsInstance.reloadSlots((progress) => {
      mainWindow.webContents.send("update-progress", progress);
    });
    mainWindow.webContents.send("reload-slots-success");
  } catch (error) {
    console.error("Error reloading slots:", error);
    mainWindow.webContents.send("reload-slots-error");
  }
});

ipcMain.handle("api-request", async (event, { type, apiKey }) => {
  //console.log("Received api-request:", type, apiKey);
  try {
    if (type === "verify-user") {
      const result = await verifyUser(apiKey);
      //console.log("User verification result:", result);
      return result;
    } else if (type === "perform-api-request") {
      // ... Votre code existant ...
    }
  } catch (error) {
    console.error("Error in api-request:", error);
    throw error;
  }
});

ipcMain.handle("make-get-request", async (event, url) => {
  return await performGetRequest(url);
});

ipcMain.handle("make-post-request", async (event, { url, params }) => {
  return await performPostRequest(url, params);
});

ipcMain.handle("get-conversion-rates", async () => {
  try {
    const rates = await getConversionRates();
    return rates;
  } catch (error) {
    console.error("Error fetching conversion rates:", error);
    throw error;
  }
});

ipcMain.handle("get-user-balances", async () => {
  try {
    const userBalances = await getUserBalances();
    return userBalances;
  } catch (error) {
    console.error("Error fetching user balances:", error);
    throw error;
  }
});

//Function

async function openLoginWindow() {
  return new Promise((resolve, reject) => {
    const loginWindow = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    loginWindow.loadURL(`https://stake.bet`);

    const checkMetaTagContent = async () => {
      const metaTagContent = await loginWindow.webContents.executeJavaScript(`
        document.querySelector('meta[name="application-name"]')?.getAttribute('content')
      `);
      return metaTagContent === "Stake";
    };

    const getCookies = async () => {
      const cookies = await loginWindow.webContents.session.cookies.get({});
      const cfBmCookie = cookies.find((cookie) => cookie.name === "__cf_bm");
      userAgent = await loginWindow.webContents.executeJavaScript(
        "navigator.userAgent"
      );
      allCookies = cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");

      const cfClearance = cookies.find(
        (cookie) => cookie.name === "cf_clearance"
      );
      if (cfClearance) {
        allCookies += `; cf_clearance=${cfClearance.value}`;
      } else {
        // Attempt to get cf_clearance cookie separately
        const cfClearanceCookie =
          await loginWindow.webContents.session.cookies.get({
            name: "cf_clearance",
          });
        if (cfClearanceCookie.length > 0) {
          allCookies += `; cf_clearance=${cfClearanceCookie[0].value}`;
        }
      }
    };

    const setupCookieChangeListener = () => {
      session.defaultSession.cookies.on(
        "changed",
        (event, cookie, cause, removed) => {
          if (cookie.name === "cf_clearance" && !removed) {
            allCookies += `; cf_clearance=${cookie.value}`;
          }
        }
      );
    };

    setupCookieChangeListener();

    const intervalId = setInterval(async () => {
      const isLoggedIn = await checkMetaTagContent();
      if (isLoggedIn) {
        clearInterval(intervalId);
        await getCookies();
        loginWindow.close();
        resolve();
      }
    }, 1000);

    loginWindow.on("closed", () => {
      clearInterval(intervalId);
      resolve();
    });
  });
}

async function performApiRequest({ url, query }) {
  if (!url || !query) {
    console.error("URL or query is missing", { url, query });
    throw new Error("URL or query is missing");
  }

  try {
    const apiKey = client.getApiKey();
    const userAgent = client.getUserAgent();
    const allCookies = client.getAllCookies();

    if (!apiKey || !userAgent || !allCookies) {
      throw new Error("API Key, User Agent, or Cookies are missing");
    }

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": userAgent,
      Cookie: allCookies,
    };

    if (url.includes("graphql")) {
      headers["x-access-token"] = apiKey;
    }

    const response = await axios.post(url, query, {
      headers: headers,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    const responseText = response.data;

    try {
      return responseText;
    } catch (error) {
      console.error("Error parsing JSON:", error);
      throw new Error("Failed to parse JSON response");
    }
  } catch (error) {
    console.error("API call error:", error);
    if (error.response) {
      console.error("Error response data:", error.response.data);
      console.error("Error response status:", error.response.status);
      console.error("Error response headers:", error.response.headers);
    }
    throw error;
  }
}

async function performGetRequest(url) {
  if (!url) {
    throw new Error("URL is missing");
  }

  const allCookies = client.getAllCookies();
  const userAgent = client.getUserAgent();

  try {
    const response = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: (status) => status < 400,
      headers: {
        "User-Agent": userAgent,
        Cookie: allCookies,
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    return {
      data: response.data,
      headers: response.headers,
    };
  } catch (error) {
    console.error("GET request error:", error);
    throw error;
  }
}

async function performPostRequest(url, params) {
  if (!url || !params) {
    throw new Error("URL or params are missing");
  }

  const allCookies = client.getAllCookies();
  const userAgent = client.getUserAgent();

  const postData = new URLSearchParams();
  for (const key in params) {
    if (params.hasOwnProperty(key)) {
      postData.append(key, params[key]);
    }
  }

  try {
    const response = await axios.post(url, postData.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent,
        Cookie: allCookies,
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    return {
      data: response.data,
      headers: response.headers,
    };
  } catch (error) {
    console.error("POST request error:", error);
    throw error;
  }
}

//ancien
async function verifyUser(apiKey) {
  //console.log("Verifying user with API key:", apiKey);
  try {
    const response = await performApiRequest({
      url: `https://stake.bet/_api/graphql`,
      query: { query, variables },
    });

    const userResponse = response.data.user;

    if (userResponse && userResponse.houseBetList) {
      userResponse.houseBetList.forEach((bet, index) => {});

      const isAuthorized = userResponse.houseBetList.some(
        (bet) =>
          bet.bet.user.name === "valsalt" ||
          bet.bet.user.name === "mcson" ||
          bet.bet.user.name === "PicsouETH" ||
          bet.bet.user.name === "PepeGambler" ||
          bet.bet.user.name === "Bitcouille" ||
          bet.bet.user.name === "Shevrier"
      );
      return isAuthorized;
    } else {
      console.log("No house bet list found or it's empty.");
      return false;
    }
  } catch (error) {
    console.error("Error verifying user:", error);
    throw error;
  }
}

async function getUserBalances() {
  const query = {
    query: `
      query UserBalances {
        user {
          id
          balances {
            available {
              amount
              currency
              __typename
            }
            vault {
              amount
              currency
              __typename
            }
            __typename
          }
          __typename
        }
      }
    `,
    operationName: "UserBalances",
  };

  const response = await performApiRequest({
    url: `https://stake.bet/_api/graphql`,
    query,
  });

  if (
    response &&
    response.data &&
    response.data.user &&
    response.data.user.balances
  ) {
    return response.data.user.balances
      .map((balance) => ({
        currency: balance.available.currency,
        amount: balance.available.amount,
      }))
      .filter((balance) => balance.amount > 0);
  } else {
    throw new Error("Unexpected API response structure");
  }
}

async function getConversionRates() {
  const query = {
    query: `query CurrencyConversionRate {
              info {
                  currencies {
                      name
                      eur: value(fiatCurrency: eur)
                      usd: value(fiatCurrency: usd)
                      ars: value(fiatCurrency: ars)
                      brl: value(fiatCurrency: brl)
                      cad: value(fiatCurrency: cad)
                      clp: value(fiatCurrency: clp)
                      cny: value(fiatCurrency: cny)
                      dkk: value(fiatCurrency: dkk)
                      idr: value(fiatCurrency: idr)
                      inr: value(fiatCurrency: inr)
                      krw: value(fiatCurrency: krw)
                      mxn: value(fiatCurrency: mxn)
                      pen: value(fiatCurrency: pen)
                      php: value(fiatCurrency: php)
                      pln: value(fiatCurrency: pln)
                      rub: value(fiatCurrency: rub)
                      try: value(fiatCurrency: try)
                      vnd: value(fiatCurrency: vnd)
                  }
              }
          }`,
  };

  const response = await performApiRequest({
    url: `https://stake.bet/_api/graphql`,
    query,
  });

  if (response && response.data && response.data.info) {
    return response.data.info.currencies;
  } else {
    throw new Error("Unexpected API response structure");
  }
}

class SlotsClient {
  constructor(mirror, userAgent, allCookies, apiKey, configPath) {
    this.mirror = mirror;
    this.userAgent = userAgent;
    this.allCookies = allCookies;
    this.apiKey = apiKey;
    this.configPath = configPath;
    this.betWS = null;
    this.pingInterval = null;
  }

  startClient() {
    if (!this.userAgent || !this.apiKey || !this.allCookies) {
      console.error(
        "User-Agent, API key, or cookies are missing. Please log in first."
      );
      return;
    }

    try {
      const headers = {
        "User-Agent": this.userAgent,
        Cookie: this.allCookies,
      };

      this.betWS = new WebSocket(
        `wss://${this.mirror}/_api/websockets`,
        "graphql-transport-ws",
        {
          headers: headers,
          rejectUnauthorized: false,
        }
      );

      this.betWS.on("open", this.onOpen.bind(this));
      this.betWS.on("close", this.onClose.bind(this));
      this.betWS.on("error", this.onError.bind(this));
      this.betWS.on("message", this.onMessage.bind(this));
    } catch (error) {
      console.error("Error starting client:", error);
    }
  }

  onOpen() {
    if (this.betWS.readyState === WebSocket.OPEN) {
      const lockdownToken = this.randomStringNum(20);
      const payload = JSON.stringify({
        type: "connection_init",
        payload: {
          accessToken: this.apiKey,
          language: "fr",
          lockdownToken: lockdownToken,
        },
      });
      this.betWS.send(payload, (err) => {
        if (err) console.error("Send error:", err);
      });

      this.pingInterval = setInterval(() => {
        this.sendPing();
      }, 30000);
    }
  }

  onClose(event) {
    clearInterval(this.pingInterval);
    setTimeout(() => this.startClient(), 1000);
  }

  onError(error) {
    console.error("WebSocket error:", error);
  }

  onMessage(message) {
    const messageStr = message.toString("utf8");
    try {
      const messageJson = JSON.parse(messageStr);

      if (messageJson.type === "connection_ack") {
        this.subscribeToHouseBets();
        this.subscribeToBalance();
        ipcMain.emit("connection-acknowledged");
      } else if (messageJson.type === "error") {
        console.error("Received error message:", messageJson);
      } else if (messageJson.type === "pong") {
      } else {
        if (
          messageJson.id &&
          messageJson.type === "next" &&
          messageJson.payload &&
          messageJson.payload.data &&
          messageJson.payload.data.availableBalances
        ) {
          mainWindow.webContents.send(
            "balance-update",
            messageJson.payload.data.availableBalances
          );
        }
        if (
          messageJson.id &&
          messageJson.type === "next" &&
          messageJson.payload &&
          messageJson.payload.data &&
          messageJson.payload.data.houseBets
        ) {
          const betData = messageJson.payload.data.houseBets.bet;
          const game = messageJson.payload.data.houseBets.game;

          const multiplierData = {
            multiplier: betData.payoutMultiplier,
            payout: betData.payout,
            currency: betData.currency,
            amount: betData.amount,
            slotName: game.name,
            iid: messageJson.payload.data.houseBets.iid,
          };

          mainWindow.webContents.send("multiplier-update", multiplierData);
        }
      }
    } catch (error) {
      console.error("Failed to parse message:", error);
    }
  }

  subscribeToHouseBets() {
    const subscriptionId = uuidv4();
    const payload = `{"id":"${subscriptionId}","type":"subscribe","payload":{"query":"subscription HouseBets {\\n  houseBets {\\n    ...RealtimeHouseBet\\n    __typename\\n  }\\n}\\n\\nfragment RealtimeHouseBet on Bet {\\n  id\\n  iid\\n  game {\\n    name\\n    icon\\n    __typename\\n  }\\n  bet {\\n    __typename\\n    ... on CasinoBet {\\n      id\\n      active\\n      payoutMultiplier\\n      amountMultiplier\\n      amount\\n      payout\\n      updatedAt\\n      currency\\n      user {\\n        id\\n        name\\n        __typename\\n      }\\n      __typename\\n    }\\n    ... on EvolutionBet {\\n      id\\n      amount\\n      currency\\n      createdAt\\n      payout\\n      payoutMultiplier\\n      user {\\n        id\\n        name\\n        __typename\\n      }\\n      __typename\\n    }\\n    ... on MultiplayerCrashBet {\\n      id\\n      payoutMultiplier\\n      amount\\n      payout\\n      currency\\n      updatedAt\\n      user {\\n        id\\n        name\\n        __typename\\n      }\\n      __typename\\n    }\\n    ... on MultiplayerSlideBet {\\n      id\\n      payoutMultiplier\\n      amount\\n      payout\\n      currency\\n      updatedAt\\n      createdAt\\n      user {\\n        id\\n        name\\n        __typename\\n      }\\n      __typename\\n    }\\n    ... on SoftswissBet {\\n      id\\n      amount\\n      currency\\n      updatedAt\\n      payout\\n      payoutMultiplier\\n      user {\\n        id\\n        name\\n        __typename\\n      }\\n      __typename\\n    }\\n    ... on ThirdPartyBet {\\n      id\\n      amount\\n      currency\\n      updatedAt\\n      createdAt\\n      payout\\n      payoutMultiplier\\n      user {\\n        id\\n        name\\n        __typename\\n      }\\n      __typename\\n    }\\n  }\\n}\\n"}}`;

    this.betWS.send(Buffer.from(payload, "utf8"), (err) => {
      if (err) console.error("Send error:", err);
    });
  }

  subscribeToBalance() {
    const subscriptionId = uuidv4();
    const payload = `{"id":"${subscriptionId}","type":"subscribe","payload":{"query":"subscription AvailableBalances {\\n  availableBalances {\\n    amount\\n    identifier\\n    balance {\\n      amount\\n      currency\\n    }\\n  }\\n}\\n"}}`;

    this.betWS.send(Buffer.from(payload, "utf8"), (err) => {
      if (err) console.error("Send error:", err);
    });
  }

  sendPing() {
    const payload = JSON.stringify({ type: "ping" });
    this.betWS.send(payload, (err) => {
      if (err) console.error("Ping send error:", err);
    });
  }

  randomStringNum(length) {
    const chars = "0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}

const providerModuleMap = {
  "hacksaw-gaming": path.join(__dirname, "../src/js/hacksaw.mjs"),
  "backseat-gaming": path.join(__dirname, "../src/js/hacksaw.mjs"),
  "bullshark-games": path.join(__dirname, "../src/js/hacksaw.mjs"),
  "bullshark games": path.join(__dirname, "../src/js/hacksaw.mjs"),
  "pragmatic-play": path.join(__dirname, "../src/js/pragma.mjs"),
  "playn-go": path.join(__dirname, "../src/js/pngo.mjs"),
  "pragmatic play": path.join(__dirname, "../src/js/pragma.mjs"),
  "play'n go": path.join(__dirname, "../src/js/pngo.mjs"),
  "hacksaw gaming": path.join(__dirname, "../src/js/hacksaw.mjs"),
  "backseat gaming": path.join(__dirname, "../src/js/hacksaw.mjs"),
  "titan gaming": path.join(__dirname, "../src/js/twist.mjs"),
  "titan-gaming": path.join(__dirname, "../src/js/twist.mjs"),
  "twist gaming": path.join(__dirname, "../src/js/twist.mjs"),
  "twist-gaming": path.join(__dirname, "../src/js/twist.mjs"),
  truelab: path.join(__dirname, "../src/js/truelab.mjs"),
};

ipcMain.handle("load-provider-module", async (event, provider) => {
  try {
    const normalizedProvider = provider.toLowerCase().replace(/[' ]/g, "-");
    //console.log("normalizedProvider", normalizedProvider); // Ajout de log
    const modulePath = providerModuleMap[normalizedProvider];

    if (!modulePath) {
      throw new Error("Unsupported provider");
    }

    if (!fs.existsSync(modulePath)) {
      throw new Error("Module not found: " + modulePath);
    }

    const moduleUrl = pathToFileURL(modulePath).href; // Conversion du chemin en URL
    const module = await import(moduleUrl); // Import dynamique

    if (!module) {
      throw new Error("Failed to load module: " + modulePath);
    }

    //console.log("Loaded module:", module); // Ajout de log

    const availableMethods = [
      "startSession",
      "handleSpin",
      "placeBet",
      "continueBet",
      "placeChoose",
      "placeBonusBet",
    ].filter(
      (method) =>
        module.default[method] && typeof module.default[method] === "function"
    );

    //console.log("Available methods:", availableMethods); // Ajout de log

    const resultModule = {};
    availableMethods.forEach((method) => {
      resultModule[method] = module.default[method].toString();
    });

    return {
      success: true,
      module: resultModule,
    };
  } catch (error) {
    console.error("Error loading provider module:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(
  "execute-provider-method",
  async (event, { provider, method, args }) => {
    try {
      const context = {
        axios,
        performApiRequest,
        performGetRequest,
        performPostRequest,
      };

      if (!provider) {
        throw new Error("Provider is undefined");
      }

      const modulePath =
        providerModuleMap[provider.toLowerCase().replace(/[' ]/g, "-")];
      if (!modulePath) {
        throw new Error("Unsupported provider");
      }

      const moduleUrl = pathToFileURL(modulePath).href;
      const module = await import(moduleUrl);

      const functionMap = {
        startSession: module.default.startSession?.bind(context),
        handleSpin: module.default.handleSpin?.bind(context),
        placeBet: module.default.placeBet?.bind(context),
        continueBet: module.default.continueBet?.bind(context),
        placeChoose: module.default.placeChoose?.bind(context),
        placeBonusBet: module.default.placeBonusBet?.bind(context),
      };

      const func = functionMap[method];
      if (typeof func !== "function") {
        throw new Error(`Method ${method} is not a function`);
      }

      const resolvedArgs = args.map((arg) =>
        typeof arg === "string" && functionMap[arg] ? functionMap[arg] : arg
      );

      const result = await func(...resolvedArgs);
      return result;
    } catch (error) {
      console.error("Error executing provider method:", error);
      throw error;
    }
  }
);

ipcMain.handle(
  "original-slot-bet",
  async (event, { slotName, amount, currency, multiplierTarget }) => {
    if (!originalSlotQueries) {
      throw new Error("Original slot queries module not initialized");
    }

    const queryFunction = originalSlotQueries[slotName.toLowerCase()];
    if (!queryFunction) {
      throw new Error(`Query not found for slot: ${slotName}`);
    }

    const query = queryFunction(amount, currency, multiplierTarget);
    const url = "https://stake.bet/_api/graphql"; // Assurez-vous que c'est la bonne URL

    try {
      const result = await performApiRequest({ url, query });
      return result;
    } catch (error) {
      console.error("Error in original slot bet:", error);
      throw error;
    }
  }
);
