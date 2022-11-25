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

const { toBN, getExpirySymbol, getLastPrice } = require("../utils")(
  web3,
  bybitSpot
);

// Map closest strikes to positions
let hedges = {};

/**
 *
 * {
 *  "NOV26-1200-P": {
 *    writes: 25,
 *    hedges: 10
 * }
 * }
 */

// Fill puts to hedge new purchases
const fillPuts = async (symbol, toFill) => {
  let markets = (await bybitOptions.getContractInfo({
    baseCoin: "ETH",
    limit: 1000
  })).result.dataList;
  markets = markets.filter(market => market.symbol === symbol);

  // Get orderbooks
  let orderbook = (await bybitOptions.getOrderBook(symbol)).result;

  // Get best ask
  orderbook = orderbook.filter(order => order.side === "Sell");

  // Write to files
  fs.writeFile("./orderbook.json", JSON.stringify(orderbook), err => {
    console.log(err ? "Error writing orderbook" : "Success");
  });

  if (orderbook.length > 0) {
    let i = 0;
    while (toFill > 0 && i <= orderbook.length) {
      let size = parseFloat(orderbook[i].size);
      let filled = 0;
      if (toFill >= size) {
        toFill -= size;
        filled += size;
      } else {
        filled += toFill;
        toFill = 0;
      }
      console.log(
        "Ask:",
        orderbook[i].size,
        "puts @",
        orderbook[i].price,
        "USDC"
      );
      console.log(
        `Filled ${filled} @ ${orderbook[i++].price}. Remaining to fill: ${toFill}`
      );
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

// Handle previous straddle purchase events for epoch
const getPreviousPurchases = async currentEpoch =>
  new Promise(resolve => {
    ethStraddle.getPastEvents("Purchase", { fromBlock: "" }, (err, events) => {
      if (!err) {
        events = events.filter(
          event => event.returnValues.epoch == currentEpoch
        );
        events = events.map(event => event.returnValues);
        resolve(events);
      }
    });
  });

// Watch straddle purchases
const watchPurchaseEvents = (expiry, poolShare) => {
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
      const expirySymbol = getExpirySymbol(expiry, apStrike);
      console.log(
        `To hedge: ${amountToHedge} puts sold @ $${apStrike} w/ ${expirySymbol}`
      );
      console.log("Checking for active hedges..");
      let hedgePositions = await getPositions(expirySymbol);
      console.log({ hedgePositions });
      await fillPuts(expirySymbol, amountToHedge);
    })
    .on("error", (err, receipt) => {
      console.error("Error on Purchase event:", err, receipt);
    });
};

(async () => {
  const currentEpoch = await ethStraddle.methods.currentEpoch().call();
  const epochData = await ethStraddle.methods.epochData(currentEpoch).call();
  const { expiry, usdDeposits, underlyingPurchased } = epochData;
  const underlyingPrice = await ethStraddle.methods.getUnderlyingPrice().call();
  const premium =
    toBN(
      await ethStraddle.methods
        .calculatePremium(true, underlyingPrice, underlyingPrice, 1e6, expiry)
        .call()
    )
      .div(toBN(1e8))
      .toNumber() / 1e6;
  let lastPrice = await getLastPrice();
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
  let totalUsdDeposits = 0;
  for (let wp of writePositionsForEpoch) {
    totalUsdDeposits = toBN(wp.usdDeposit)
      .add(toBN(totalUsdDeposits))
      .toString();
  }
  let availableUsdDeposits = toBN(totalUsdDeposits).toNumber() / 1e6;
  let totalSellableStraddles =
    toBN(totalUsdDeposits).toNumber() / 1e6 / lastPrice;
  let poolShare =
    toBN(totalUsdDeposits)
      .mul(toBN(1e8)) // 1e6 (multiplier) * 1e2 (100%)
      .div(toBN(usdDeposits))
      .toNumber() / 1e6;
  let poolPutsToPurchase = (underlyingPurchased * 2) / 1e18;
  let writerPutsToPurchase = (underlyingPurchased * 2 * poolShare) / 1e20;
  console.log("Total available USD deposits:", availableUsdDeposits);
  console.log("Total sellable straddles:", totalSellableStraddles);
  console.log("Share of pool:", poolShare, "%");
  console.log("Pool puts to purchase:", poolPutsToPurchase);
  console.log("Writer puts to purchase:", writerPutsToPurchase);

  console.log({ underlyingPrice, premium });

  const previousPurchases = await getPreviousPurchases(
    currentEpoch,
    expiry,
    poolShare
  );
  console.log("Previous purchase events:", previousPurchases);
  watchPurchaseEvents(expiry, poolShare);
})();
