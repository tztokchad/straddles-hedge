# Atlantic straddles hedge

Sample code to hedge Atlantic straddle write position purchases against Bybit with long puts

## Instructions

1. Create a [Bybit](https://bybit.com) account
2. Generate [Bybit](https://bybit.com) API key + secret and add to `.env`
3. Get an [Arbitrum](https://offchainlabs.com) WSS RPC URL and add to `.env` - I'd recommend [Alchemy](https://alchemy.com)
4. Deposit to [Dopex Atlantic Straddles](https://app.dopex.io/straddles) and add your writer address to `.env`
5. Run the script

## Historical APY

Run the [straddles hedge simulation](https://github.com/tztokchad/straddles-hedge-sim) to find out historical APY from writing + hedging Atlantic Straddles

Here are some examples:

APY from Jan 1 2022 to Nov. 20 2022:
![APY from Jan 1 2022](https://pbs.twimg.com/media/FiBB6P3XkAATBmm?format=png&name=small)

APY from Jan 1 2021 to Nov. 20 2022:
![APY from Jan 1 2021](https://pbs.twimg.com/media/FiBDhBCXgAEzebY?format=png&name=small)

### Run

```bash
yarn
yarn start
```
