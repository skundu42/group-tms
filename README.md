# Circles Group Trust Management service

Minimal service that:

* scans Circles **BackingCompleted**/**BackingInitiated** events,
* filters out blacklisted backers,
* **trusts** valid new backers into a group in batches of 50,
* reconciles initiated-but-not-completed processes (resets CowSwap order or creates LBP),
* optionally notifies Slack when something looks stuck,
* runs once a minute.

## Requirements

* Node.js **≥ 24**
* A Circles RPC endpoint (e.g. https://rpc.aboutcircles.com/)
* A private key that is the **group service** for the backers group

## Quick start

```bash
# 1) Install
npm install

# 2) Configure
touch .env   # Check the values below and fill in your .env file

# 3) Run (TypeScript directly)
npx ts-node src/main.ts

# Alternative: build then run
npx tsc && node dist/main.js
```

## Configuration (.env)

```dotenv
# RPC & addresses
RPC_URL=https://rpc.aboutcircles.com/
BACKING_FACTORY_ADDRESS=0xeced91232c609a42f6016860e8223b8aecaa7bd0
BACKERS_GROUP_ADDRESS=0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026

# Private key (must be the group's service)
SERVICE_PRIVATE_KEY=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

# Blacklist service
BLACKLISTING_SERVICE_URL=https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/classify

# Scan window / timing
START_AT_BLOCK=39743285
CONFIRMATION_BLOCKS=2
EXPECTED_SECONDS_TILL_COMPLETION=60

# Notifications
SLACK_WEBHOOK_URL=

# Logging
VERBOSE_LOGGING=1     # any truthy value enables debug/table
```

## What it does (at a glance)

* Uses a reorg buffer (`CONFIRMATION_BLOCKS`) from chain head.
* From `START_AT_BLOCK` → head:
    * pulls **BackingCompleted**, filters via blacklist service, dedupes already-trusted backers, and calls
      `trustBatchWithConditions(group, addresses, expiry=max uint96)` in batches of 50.
    * finds **BackingInitiated** without matching completion:
        * if **past deadline** (initiated timestamp + 24h): try `createLBP()`; notify Slack on inconsistent/insufficient states.
        * if **before deadline**: try `resetCowswapOrder()` when valid; if already settled, attempt LBP creation.
* Logs summaries by default; `VERBOSE_LOGGING` prints debug and tables.
* Keeps running: initial run, then every minute.

## Operational notes

* Make sure `SERVICE_PRIVATE_KEY` controls the group’s **service** role; otherwise transactions will fail.
* Slack notifications are best-effort; failures throw and crash the process.
* If you change the factory, bump `START_AT_BLOCK` accordingly.
* This service is stateless; it does not store any data between runs.
* It fails loudly on errors and thus requires a supervisor to monitor and restart it.