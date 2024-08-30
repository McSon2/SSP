//main.cjs

const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const https = require("https");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const { pathToFileURL } = require("url");
const localtunnel = require("localtunnel");
const { autoUpdater } = require("electron-updater");

let stakeUsername = null;

let tunnelUrl;
let query,
  variables,
  ReloadSlots,
  originalSlotQueries,
  databaseManager,
  startServer;
const PLISIO_API_KEY =
  "5exg7sOZ8JPiZDxNJA_rzNK2_5Dgqt1arGSPu2tFPw5qvgBZUkOjWgQFusjb2GaE";

async function initializeModules() {
  try {
    try {
      const databaseManagerModule = await import(
        "../src/js/DatabaseManager.mjs"
      );

      databaseManager = databaseManagerModule.default;
      await databaseManager.connect();
    } catch (error) {
      console.error("Error during database initialization:", error);
      console.error("Error stack:", error.stack);
    }

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

    const serverModule = await import("./server.js");
    startServer = serverModule.startServer;
  } catch (error) {
    console.error("Error initializing modules:", error);
  }
}

let mainWindow;
let userAgent = "";
let allCookies = "";
let slotsClient = null;
let reloadSlotsInstance;

let server;
let tunnel;

async function startServerAndTunnel() {
  if (typeof startServer === "function") {
    try {
      const { port, server: newServer } = await startServer(
        handleServerCallback
      );
      server = newServer;

      // Create a tunnel
      tunnel = await localtunnel({ port });
      tunnelUrl = tunnel.url;

      tunnel.on("close", () => {});
    } catch (serverError) {
      console.error("Error starting server:", serverError);
      throw serverError;
    }
  } else {
    console.error("startServer is not a function. Type:", typeof startServer);
    throw new Error("startServer is not a function");
  }
}

async function stopServerAndTunnel() {
  try {
    if (tunnel) {
      await new Promise((resolve, reject) => {
        tunnel.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      tunnel = null;
    }
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      server = null;
    }
    tunnelUrl = null;
  } catch (error) {
    console.error("Error in stopServerAndTunnel:", error);
    throw error; // Re-throw the error to be caught by the IPC handler
  }
}

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

  function checkForUpdates() {
    autoUpdater.checkForUpdatesAndNotify();
  }

  mainWindow.webContents.on("did-finish-load", () => {
    checkForUpdates();
  });

  autoUpdater.on("checking-for-update", () => {});
  autoUpdater.on("update-available", (info) => {
    mainWindow.webContents.send("update_available");
  });
  autoUpdater.on("update-not-available", (info) => {});
  autoUpdater.on("error", (err) => {});
  autoUpdater.on("download-progress", (progressObj) => {});
  autoUpdater.on("update-downloaded", (info) => {
    mainWindow.webContents.send("update_downloaded");
  });

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

function sendPaymentCompletedToRenderer(orderNumber) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("payment-completed", orderNumber);
  } else {
    console.error(
      `Main process: mainWindow is not available to send payment-completed event for order: ${orderNumber}`
    );
  }
}

async function handleServerCallback(action, ...args) {
  switch (action) {
    case "update-invoice-status":
      return await databaseManager.updateInvoiceStatus(...args);
    case "get-invoice":
      return await databaseManager.getInvoice(...args);
    case "payment-completed":
      const [orderNumber] = args;
      sendPaymentCompletedToRenderer(orderNumber);
      break;
    case "update-user-subscription":
      try {
        const [
          stakeUsername,
          subscriptionType,
          subscriptionEnd,
          amount,
          currency,
          invoiceTotalSum,
        ] = args;
        const user = await databaseManager.getUser(stakeUsername);
        let result;
        if (user) {
          result = await databaseManager.updateUserSubscription(
            stakeUsername,
            subscriptionType,
            subscriptionEnd,
            amount,
            currency,
            invoiceTotalSum
          );
        } else {
          result = await databaseManager.addUser(
            stakeUsername,
            subscriptionType,
            new Date(),
            subscriptionEnd,
            amount,
            currency,
            invoiceTotalSum
          );
        }
        //await stopServerAndTunnel();
        return result;
      } catch (error) {
        console.error("Error updating user subscription:", error);
        //await stopServerAndTunnel();
        throw error;
      }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

app.whenReady().then(async () => {
  try {
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (error) {
    console.error("Error in app initialization:", error);
  }
});

app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    await databaseManager.close();
    await stopServerAndTunnel();
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

ipcMain.handle("stop-server-and-tunnel", async () => {
  try {
    await stopServerAndTunnel();
    return { success: true };
  } catch (error) {
    console.error("Error stopping server and tunnel:", error);
    return { success: false, error: error.message };
  }
});

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

ipcMain.handle("api-request", async (event, { type, ...params }) => {
  try {
    switch (type) {
      case "verify-user":
        return await verifyUser(params.apiKey);
      case "create-invoice":
        return await createPlisioInvoice(params);
      // ... autres cas existants ...
      default:
        throw new Error(`Unknown request type: ${type}`);
    }
  } catch (error) {
    //console.error("Error in api-request:", error);
    //throw error;
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

ipcMain.handle("update-api-key", async (event, newApiKey) => {
  const configPath = path.join(app.getPath("userData"), "config.json");
  let config = {};

  if (fs.existsSync(configPath)) {
    const fileContent = fs.readFileSync(configPath, "utf8");
    config = JSON.parse(fileContent);
  }

  config.apiKey = newApiKey;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
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

//nouveau
async function verifyUser(apiKey) {
  try {
    const response = await performApiRequest({
      url: `https://stake.bet/_api/graphql`,
      query: { query, variables },
    });

    const userResponse = response.data.user;

    if (
      userResponse &&
      userResponse.houseBetList &&
      userResponse.houseBetList.length > 0
    ) {
      stakeUsername = userResponse.houseBetList[0].bet.user.name;
      const user = await databaseManager.getUser(stakeUsername);

      if (user) {
        const now = new Date();
        const subscriptionEnd = new Date(user.subscription_end);

        if (now <= subscriptionEnd) {
          return {
            isValid: true,
            message: `Welcome back, ${stakeUsername}! Your subscription is valid until ${subscriptionEnd.toLocaleDateString()}.`,
          };
        } else {
          return {
            isValid: false,
            message: `Your subscription expired on ${subscriptionEnd.toLocaleDateString()}. Please renew to continue.`,
            needsRenewal: true,
          };
        }
      } else {
        return {
          isValid: false,
          message: `Welcome, ${stakeUsername}! Please subscribe to use the application.`,
          needsSubscription: true,
        };
      }
    } else {
      return {
        isValid: false,
        message: "Failed to verify user with Stake. Please try again.",
      };
    }
  } catch (error) {
    console.error("Error verifying user:", error);
    return {
      isValid: false,
      message: "An error occurred during verification. Please try again.",
    };
  }
}

// Add this new IPC handler
ipcMain.handle("get-stake-username", (event) => {
  return stakeUsername;
});

const baseAmounts = {
  "1_month": 19.99,
  "3_months": 49.99,
  "6_months": 79.99,
  "12_months": 139.99,
};

let currentPrices = { ...baseAmounts };

ipcMain.handle("apply-promo", async (event, promoCode, subscriptionType) => {
  try {
    const promoResult = await databaseManager.verifyPromoCode(
      promoCode,
      subscriptionType
    );
    if (promoResult.isValid) {
      currentPrices = { ...baseAmounts };
      currentPrices[subscriptionType] *= 1 - promoResult.discount;
      return {
        success: true,
        updatedPrices: currentPrices,
        appliedTo: subscriptionType,
      };
    } else {
      return { success: false, message: promoResult.message };
    }
  } catch (error) {
    console.error("Error verifying promo code:", error);
    return {
      success: false,
      message: "An error occurred while verifying the promo code.",
    };
  }
});

async function createPlisioInvoice({
  stakeUsername,
  subscriptionType,
  currency,
  promoCode,
}) {
  // Start server and tunnel before creating invoice
  await startServerAndTunnel();

  let amount = currentPrices[subscriptionType];

  if (promoCode) {
    const promoResult = await databaseManager.verifyPromoCode(
      promoCode,
      subscriptionType
    );
    if (promoResult.isValid) {
      amount *= 1 - promoResult.discount;
    }
  }

  const url = `${tunnelUrl}/plisio-callback?json=true`;

  const orderNumber = `${stakeUsername}-${Date.now()}`;

  try {
    const response = await axios.get(
      "https://api.plisio.net/api/v1/invoices/new",
      {
        params: {
          source_currency: "USD",
          source_amount: amount,
          currency: "BTC",
          order_number: orderNumber,
          order_name: `Subscription ${subscriptionType}`,
          email: "customer@example.com",
          callback_url: url,
          success_url: "https://yourapp.com/success",
          cancel_url: "https://yourapp.com/cancel",
          api_key: PLISIO_API_KEY,
        },
      }
    );

    if (response.data.status === "success") {
      const invoiceData = response.data.data;

      try {
        await databaseManager.createInvoice(
          invoiceData.txn_id,
          orderNumber,
          stakeUsername,
          subscriptionType,
          invoiceData.invoice_total_sum,
          currency,
          "pending"
        );
      } catch (dbError) {
        console.error("Error creating invoice in database:", dbError);
        throw dbError;
      }

      currentPrices = { ...baseAmounts };

      return invoiceData.invoice_url;
    } else {
      throw new Error("Failed to create Plisio invoice");
    }
  } catch (error) {
    console.error("Error creating Plisio invoice:", error);
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
