import express from "express";
import bodyParser from "body-parser";
import getPort from "get-port";
import crypto from "crypto";

const app = express();

app.use(bodyParser.json());

let mainProcessCallback;

const SECRET_KEY =
  "5exg7sOZ8JPiZDxNJA_rzNK2_5Dgqt1arGSPu2tFPw5qvgBZUkOjWgQFusjb2GaE";

function verifyCallbackData(data) {
  if (typeof data === "object" && data.verify_hash && SECRET_KEY) {
    const ordered = { ...data };
    delete ordered.verify_hash;
    const string = JSON.stringify(ordered);
    const hmac = crypto.createHmac("sha1", SECRET_KEY);
    hmac.update(string);
    const hash = hmac.digest("hex");
    return hash === data.verify_hash;
  }
  return false;
}

app.post("/plisio-callback", async (req, res) => {
  console.log("Received Plisio callback:", req.body);

  if (!verifyCallbackData(req.body)) {
    console.error("Invalid callback data");
    return res.status(422).send("Invalid callback data");
  }

  const { txn_id, status, order_number, amount, currency, invoice_total_sum } =
    req.body;

  //console.log(`Updating invoice status: ${order_number} ${status}`);
  await mainProcessCallback(
    "update-invoice-status",
    order_number,
    status,
    txn_id
  );

  if (status === "completed") {
    try {
      //console.log("Getting invoice:", order_number);
      const invoice = await mainProcessCallback("get-invoice", order_number);

      if (invoice) {
        //console.log("Invoice found:", invoice);
        console.log(`Server: Payment completed for order: ${order_number}`);
        await mainProcessCallback("payment-completed", order_number);
        console.log(
          `Server: Called mainProcessCallback with payment-completed event`
        );

        const stakeUsername = invoice.stake_username;
        const subscriptionEnd = calculateSubscriptionEnd(
          invoice.subscription_type
        );
        await mainProcessCallback(
          "update-user-subscription",
          stakeUsername,
          invoice.subscription_type,
          subscriptionEnd,
          amount,
          currency,
          invoice_total_sum
        );
        //console.log("User subscription updated successfully");
        res.status(200).send("OK");
      } else {
        //console.log("Invoice not found for order_number:", order_number);
        res.status(404).send("Invoice not found");
      }
    } catch (error) {
      console.error("Error processing callback:", error);
      res.status(500).send("Internal server error");
    }
  } else {
    //console.log(`Payment status: ${status}`);
    res.status(200).send(`Payment status: ${status}`);
  }
});

function calculateSubscriptionEnd(subscriptionType) {
  const now = new Date();
  switch (subscriptionType) {
    case "1_month":
      return new Date(now.setMonth(now.getMonth() + 1));
    case "2_months":
      return new Date(now.setMonth(now.getMonth() + 2));
    case "6_months":
      return new Date(now.setMonth(now.getMonth() + 6));
    case "12_months":
      return new Date(now.setFullYear(now.getFullYear() + 1));
    default:
      throw new Error("Invalid subscription type");
  }
}

async function startServer(callback) {
  mainProcessCallback = callback;
  const port = await getPort({ port: [3000, 3001, 3002, 3003, 3004, 3005] });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      //console.log(`Server running on port ${port}`);
      resolve({ port, server });
    });
    server.on("error", reject);
  });
}

export { startServer };

// For CommonJS compatibility
if (typeof module !== "undefined" && module.exports) {
  module.exports = { startServer };
}
