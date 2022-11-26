require("dotenv").config();

const { SpotClientV3, USDCOptionClient } = require("bybit-api");

const fs = require("fs");
const Web3 = require("web3");
const web3 = new Web3(process.env.RPC_URL);

const ethStraddle = new web3.eth.Contract(
  require("../abi/ETHAtlanticStraddle.json").abi,
  require("../abi/ETHAtlanticStraddle.json").address
);

const client = {
  key: process.env.API_KEY,
  secret: process.env.API_SECRET
};
const writerAddress = process.env.WRITER_ADDRESS;

const bybitSpot = new SpotClientV3();
const bybitOptions = new USDCOptionClient({
  key: client.key,
  secret: client.secret,
  testnet: false
});

const { toBN, getExpirySymbol } = require("../utils")(web3, bybitSpot);

// Map closest strikes to positions
let hedges = {};

// Expiry timestamp
let epochExpiry;
// Share of pool
let poolShare;

// Market buy puts from bybit
const marketBuyPuts = async (symbol, size) => {
  let params = {
    symbol,
    orderType: "Market",
    side: "Buy",
    orderQty: size.toFixed(1),
    timeInForce: "ImmediateOrCancel",
    orderLinkId: Date.now().toString()
  };
  console.log("Market buying puts:", params);
  const response = await bybitOptions.submitOrder(params);
  if (response.retCode !== 0)
    throw new Error(`Bybit: submitting order: ${response.retMsg}`);
};

// Save orderbook for reference
const saveOrderbook = orderbook =>
  fs.writeFile("./orderbook.json", JSON.stringify(orderbook), err => {
    console.log(
      err ? "Error writing orderbook" : "Successfully saved orderbook"
    );
  });

// Fill puts to hedge new purchases
const fillPuts = async (symbol, toFill, premiumPerStraddle) => {
  let markets = (await bybitOptions.getContractInfo({
    baseCoin: "ETH",
    limit: 1000
  })).result.dataList;
  markets = markets.filter(market => market.symbol === symbol);

  // Get orderbooks
  let orderbook = (await bybitOptions.getOrderBook(symbol)).result;

  // Get best ask
  orderbook = orderbook.filter(order => order.side === "Sell");

  // Save orderbook for reference
  saveOrderbook(orderbook);

  if (orderbook.length > 0) {
    let i = 0;
    let priceTooHigh = false;
    while (toFill > 0 && i <= orderbook.length && !priceTooHigh) {
      // Hedge only if price is lesser than premium collected
      if (orderbook[i].price <= premiumPerStraddle) {
        console.log(`Puts available @ ${orderbook[i].price}`);
        let size = parseFloat(orderbook[i].size);
        let filled = 0;
        if (toFill >= size) {
          await marketBuyPuts(symbol, size);
          toFill -= size;
          filled += size;
        } else {
          await marketBuyPuts(symbol, toFill);
          filled += toFill;
          toFill = 0;
        }
        console.log(
          `Filled ${filled} @ ${orderbook[i++].price}. Remaining to fill: ${toFill}`
        );
      } else {
        console.error(
          `Cannot hedge. Price of puts (${orderbook[i].price}) is greater than premium per straddle (${premiumPerStraddle})`
        );
        priceTooHigh = true;
      }
    }
  }
};

// Retrieve bybit portfolio positions
const getPositions = async expirySymbol => {
  let positions = await bybitOptions.getPositions({
    category: "OPTION",
    baseCoin: "ETH"
  });
  return positions.result.dataList.filter(
    position => position.symbol === expirySymbol
  );
};

// Get previous straddle purchase events for epoch
const getPreviousPurchases = async currentEpoch =>
  new Promise((resolve, reject) => {
    ethStraddle.getPastEvents(
      "Purchase",
      { fromBlock: "" },
      async (err, events) => {
        if (!err) {
          events = events.filter(
            event => event.returnValues.epoch == currentEpoch
          );
          events = await Promise.all(
            events.map(async event => {
              const { straddleId } = event.returnValues;
              const {
                apStrike,
                underlyingPurchased
              } = await ethStraddle.methods
                .straddlePositions(straddleId)
                .call();
              return {
                ...event.returnValues,
                apStrike,
                underlyingPurchased
              };
            })
          );
          resolve(events);
        } else reject(err);
      }
    );
  });

// Watch straddle purchases
const watchPurchaseEvents = () => {
  ethStraddle.events
    .Purchase({
      fromBlock: "latest"
    })
    .on("connected", () => console.log("Listening for purchase events"))
    .on("data", async event => {
      let { user, straddleId, cost } = event.returnValues;
      cost =
        toBN(cost)
          .div(toBN("100000000000000000000"))
          .toNumber() / 1e6;
      let {
        apStrike,
        underlyingPurchased
      } = await ethStraddle.methods.straddlePositions(straddleId).call();
      apStrike = apStrike / 1e8;
      underlyingPurchased = underlyingPurchased / 1e18;
      const premiumPerStraddle = cost / (underlyingPurchased * 2);
      console.log("New purchase event:", {
        user,
        straddleId,
        cost,
        premiumPerStraddle
      });
      const amountToHedge = (underlyingPurchased * 2 * poolShare) / 100;
      // Get symbol for Bybit expiry
      const expirySymbol = getExpirySymbol(
        epochExpiry,
        apStrike,
        premiumPerStraddle
      );
      console.log(
        `To hedge: ${amountToHedge} puts sold @ $${apStrike} w/ ${expirySymbol}`
      );
      await fillPuts(expirySymbol, amountToHedge, premiumPerStraddle);
    })
    .on("error", (err, receipt) => {
      console.error("Error on Purchase event:", err, receipt);
    });
};

// Watch for new bootstraps. If done, reset the bot
const watchBootstrapEvents = () => {
  ethStraddle.events
    .Bootstrap({
      fromBlock: "latest"
    })
    .on("connected", () => console.log("Listening for bootstrap events"))
    .on("data", async event => {
      // Re-run script
      await run();
    })
    .on("error", (err, receipt) => {
      console.error("Error on Bootstrap event:", err, receipt);
    });
};

async function run(isInit) {
  const currentEpoch = await ethStraddle.methods.currentEpoch().call();
  const epochData = await ethStraddle.methods.epochData(currentEpoch).call();
  const { expiry, usdDeposits } = epochData;
  epochExpiry = expiry;
  console.log("Straddles data for epoch", currentEpoch, ":", epochData);

  // Get all write positions for address
  const writePositions = await ethStraddle.methods
    .writePositionsOfOwner(writerAddress)
    .call();

  // Don't continue if write positions don't exist
  if (writePositions.length == 0)
    throw new Error("No write positions to hedge");

  // Filter write position data
  const writePositionsForEpoch = [];
  for (let _wp of writePositions) {
    const wp = await ethStraddle.methods.writePositions(_wp).call();
    if (wp.epoch === currentEpoch) writePositionsForEpoch.push(wp);
  }

  // Don't continue if write positions for epoch don't exist
  if (writePositionsForEpoch.length == 0)
    throw new Error("No write positions for this epoch to hedge");

  // Calculate total USD deposits
  let writerUsdDeposits = 0;
  for (let wp of writePositionsForEpoch) {
    writerUsdDeposits = toBN(wp.usdDeposit)
      .add(toBN(writerUsdDeposits))
      .toString();
  }
  poolShare =
    toBN(writerUsdDeposits)
      .mul(toBN(1e8)) // 1e6 (multiplier) * 1e2 (100%)
      .div(toBN(usdDeposits))
      .toNumber() / 1e6;
  console.log("Share of pool:", poolShare, "%");

  const previousPurchases = await getPreviousPurchases(
    currentEpoch,
    epochExpiry,
    poolShare
  );
  for (let purchase of previousPurchases) {
    // Get symbol for Bybit expiry
    let { apStrike, underlyingPurchased, cost, straddleId } = purchase;
    const premiumPerStraddle = cost / (underlyingPurchased * 2) / 1e8;
    const expirySymbol = getExpirySymbol(
      epochExpiry,
      purchase.apStrike / 1e8,
      premiumPerStraddle
    );
    apStrike = apStrike / 1e8;
    underlyingPurchased = underlyingPurchased / 1e18;
    console.log("Previous purchase event:", {
      straddleId,
      cost,
      premiumPerStraddle,
      underlyingPurchased,
      poolShare
    });
    const amountToHedge = (underlyingPurchased * 2 * poolShare) / 100;
    if (!hedges.hasOwnProperty(expirySymbol)) {
      hedges[expirySymbol] = {
        hedges: 0,
        writes: 0,
        premiumCollected: 0
      };
      let hedgePositions = await getPositions(expirySymbol);
      for (let position of hedgePositions) {
        hedges[expirySymbol].hedges += parseFloat(position.size);
      }
    }
    hedges[expirySymbol].premiumCollected += (cost * poolShare) / 1e28;
    hedges[expirySymbol].writes += amountToHedge;
  }

  console.log("Open hedges:", hedges);

  for (let strike of Object.keys(hedges)) {
    if (hedges[strike].hedges < hedges[strike].writes) {
      let toFill = hedges[strike].writes - hedges[strike].hedges;
      let premiumPerStraddle =
        hedges[strike].premiumCollected / hedges[strike].writes;
      console.log(
        `Need to hedge an additional ${toFill} puts @ ${strike} (Must cost below $${premiumPerStraddle.toFixed(
          1
        )})`
      );
      await fillPuts(strike, toFill, premiumPerStraddle);
    }
  }

  // Watch for new events if initial run
  if (isInit) {
    watchBootstrapEvents();
    watchPurchaseEvents();
  }
}

run(true);
