// All runtime settings come from environment variables. Nothing secret lives in the repo.
export const config = {
  aggAppId: process.env.AGG_APP_ID || undefined,                  // Agg x-app-id (not a secret, but kept out of git)
  payTo: process.env.FINE_PRINT_PAY_TO || "",                      // PLACEHOLDER: Baheet's Base USDC receiving address (0x...)
  price: process.env.FINE_PRINT_PRICE || "$0.05",                  // per paid check
  network: (process.env.FINE_PRINT_NETWORK || "eip155:8453") as `${string}:${string}`, // Base mainnet (PayBox supports Base + Solana USDC)
  facilitatorUrl: process.env.X402_FACILITATOR_URL || "",          // optional custom facilitator; default = Coinbase CDP facilitator
  cdpKeyId: process.env.CDP_API_KEY_ID || "",
  cdpKeySecret: process.env.CDP_API_KEY_SECRET || "",
};
export const paidMode = () => !!config.payTo && (!!config.facilitatorUrl || (!!config.cdpKeyId && !!config.cdpKeySecret));
