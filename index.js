require("dotenv").config();

const { SpotClientV3, USDCOptionClient } = require("bybit-api");

const fs = require("fs");
const Web3 = require("web3");
const web3 = new Web3(process.env.RPC_URL);

const ethStraddle = new web3.eth.Contract(
  require("./ETHAtlanticStraddle.json").abi,
  require("./ETHAtlanticStraddle.json").address
);

const client = {
  key: process.env.API_KEY,
  secret: process.env.API_SECRET
};
const writerAddress = process.env.WRITER_ADDRESS;

let nextExpiry = "23NOV22";

const bybitSpot = new SpotClientV3();
const bybitOptions = new USDCOptionClient({
  key: client.key,
  secret: client.secret,
  testnet: false
});

const toBN = n => web3.utils.toBN(n);

const getLastPrice = async () =>
  parseFloat((await bybitSpot.getLastTradedPrice("ETHUSDT")).result.price);

// Fill puts to hedge new purchases
const fillPuts = async (lastPrice, toFill) => {
  // Compute strike closest to last price
  let closest = (Math.floor(lastPrice / 25) * 25).toString();

  let markets = (await bybitOptions.getContractInfo({
    baseCoin: "ETH",
    limit: 1000
  })).result.dataList;
  markets = markets.filter(
    market =>
      market.symbol.split("-")[1] === nextExpiry &&
      market.symbol.split("-")[2] === closest &&
      market.symbol.split("-")[3] === "P"
  );

  // Get orderbooks
  const symbol = markets[0].symbol;
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

// Watch straddle purchases
const watchPurchaseEvents = () => {
  ethStraddle.events
    .Purchase({
      fromBlock: "39885610"
    })
    .on("connected", () => console.log("Listening for purchase events"))
    .on("data", event => {
      let { user, straddleId, cost } = event.returnValues;
      cost =
        toBN(cost)
          .div(toBN("100000000000000000000"))
          .toNumber() / 1e6;
      console.log("New purchase event:", { user, straddleId, cost });
    })
    .on("error", (err, receipt) => {
      console.error("Error on Purchase event:", err, receipt);
    });
};

(async () => {
  const currentEpoch = await ethStraddle.methods.currentEpoch().call();
  const epochData = await ethStraddle.methods.epochData(currentEpoch).call();
  const { expiry } = epochData;
  const underlyingPrice = await ethStraddle.methods.getUnderlyingPrice().call();
  const premium =
    toBN(
      await ethStraddle.methods
        .calculatePremium(true, underlyingPrice, 1e6, expiry)
        .call()
    )
      .div(toBN(1e8))
      .toNumber() / 1e6;
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
  let lastPrice = await getLastPrice();
  let availableUsdDeposits = toBN(totalUsdDeposits).toNumber() / 1e6;
  let totalSellableStraddles =
    toBN(totalUsdDeposits).toNumber() / 1e6 / lastPrice;
  let poolShare =
    toBN(totalUsdDeposits)
      .mul(toBN(1e8)) // 1e6 (multiplier) * 1e2 (100%)
      .div(toBN(epochData.usdDeposits))
      .toNumber() / 1e6;
  console.log("Total available USD deposits:", availableUsdDeposits);
  console.log("Total sellable straddles:", totalSellableStraddles);
  console.log("Share of pool:", poolShare, "%");

  console.log({ underlyingPrice, premium });

  watchPurchaseEvents();
  // await fillPuts(lastPrice, totalSellableStraddles);
})();
