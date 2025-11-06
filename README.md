# Circles Group Trust Management Service

Three specialized services for Circles protocol trust management:

## CRC Backers App
* Scans Circles **BackingCompleted**/**BackingInitiated** events
* Filters out blacklisted backers
* **Trusts** valid new backers into a group in batches of 50
* Reconciles initiated-but-not-completed processes (resets CowSwap order or creates LBP)
* Optionally notifies Slack when something looks stuck
* Runs once a minute

## GP CRC App
* Scans Circles **RegisterHuman** events for newly registered avatars
* Cross-checks avatars against the blacklist service and Metri Safe GraphQL data
* Trusts eligible avatars into the configured group in batches (default 10)
* Supports dry-run mode and Slack notifications
* Runs every 10 minutes

## OIC App  
* Monitors affiliate group changes and trust relationships
* Reconciles trust between MetaOrg trustees and affiliates
* Supports dry-run mode for testing
* Incremental scanning with configurable refresh intervals
* Batch processing for efficient trust operations

## Requirements

* Node.js **≥ 24**
* A Circles RPC endpoint (e.g. https://rpc.aboutcircles.com/)
* A private key that is the **group service** for the backers group

## Quick start

### Local Development

```bash
# 1) Install
npm install

# 2) Configure
touch .env   # Check the values below and fill in your .env file

# 3) Run

# Option A: build then run with .env
npx tsc && node --env-file=.env dist/src/main.js

# Option B: use scripts (also load .env)
npm run start:crc-backers
npm run start:gp-crc
npm run start:oic
npm run start:all
```

## Configuration (.env)

### CRC Backers App Configuration

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

### GP CRC App Configuration

```dotenv
# RPC & addresses
RPC_URL=https://rpc.aboutcircles.com/
GP_CRC_GROUP_ADDRESS=0xb629a1e86f3efada0f87c83494da8cc34c3f84ef

# Private key (must control the group's service role unless dry run)
GP_CRC_SERVICE_PRIVATE_KEY=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SERVICE_PRIVATE_KEY=                     # Optional fallback for GP_CRC_SERVICE_PRIVATE_KEY

# Metri Safe GraphQL
METRI_SAFE_GRAPHQL_URL=https://gnosis-e702590.dedicated.hyperindex.xyz/v1/graphql
METRI_SAFE_API_KEY=                      

# Blacklist service
BLACKLISTING_SERVICE_URL=https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/classify

# Scan window / timing
START_AT_BLOCK=31734312
CONFIRMATION_BLOCKS=10
DRY_RUN=0                                 # Set to "1" to skip transactions

# Notifications
SLACK_WEBHOOK_URL=

# Logging
VERBOSE_LOGGING=1
```

### OIC App Configuration

```dotenv
# RPC & addresses
RPC_URL=https://rpc.aboutcircles.com/
OIC_GROUP_ADDRESS=0x4E2564e5df6C1Fb10C1A018538de36E4D5844DE5
OIC_META_ORG_ADDRESS=                    # REQUIRED - Meta organization address
AFFILIATE_REGISTRY_ADDRESS=0xca8222e780d046707083f51377b5fd85e2866014

# Private key (required unless dry run)
OIC_SERVICE_PRIVATE_KEY=                 # Can also use SERVICE_PRIVATE_KEY
SERVICE_PRIVATE_KEY=                     # Fallback if OIC_SERVICE_PRIVATE_KEY not set

# Scan window / timing
START_AT_BLOCK=41734312
CONFIRMATION_BLOCKS=10
REFRESH_INTERVAL_SEC=60

# Operation mode
OIC_DRY_RUN=0                           # Set to "1" for dry run mode (no actual transactions)

# Notifications
SLACK_WEBHOOK_URL=

# Logging
VERBOSE_LOGGING=1     # any truthy value enables debug/table
```

### Gnosis Group App Configuration

```dotenv
# RPC & addresses
RPC_URL=https://rpc.aboutcircles.com/

# External services
BLACKLISTING_SERVICE_URL=https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/classify
GNOSIS_GROUP_SCORING_URL=https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/scoring/relative_trustscore/batch

# Operation mode
GNOSIS_GROUP_DRY_RUN=0                 # Set to "1" to skip blacklist & scoring requests

# Notifications
GNOSIS_GROUP_SLACK_WEBHOOK_URL=        # Optional override; falls back to SLACK_WEBHOOK_URL
SLACK_WEBHOOK_URL=

# Logging
VERBOSE_LOGGING=1
```

## What each app does

### CRC Backers App

* Uses a reorg buffer (`CONFIRMATION_BLOCKS`) from chain head
* From `START_AT_BLOCK` → head:
   * Pulls **BackingCompleted**, filters via blacklist service, dedupes already-trusted backers, and calls
     `trustBatchWithConditions(group, addresses, expiry=max uint96)` in batches of 50
   * Finds **BackingInitiated** without matching completion:
       * If **past deadline** (initiated timestamp + 24h): try `createLBP()`; notify Slack on inconsistent/insufficient states
       * If **before deadline**: try `resetCowswapOrder()` when valid; if already settled, attempt LBP creation
* Logs summaries by default; `VERBOSE_LOGGING` prints debug and tables
* Keeps running: initial run, then every minute

### GP CRC App

* Walks block ranges from `START_AT_BLOCK` to the safe head (`head - CONFIRMATION_BLOCKS`) and fetches `RegisterHuman` events via `circles_events`
* Deduplicates avatars, checks them against the blacklist in chunks, and verifies a configured Metri Pay safe exists
* Skips avatars without safes or already trusted in `GP_CRC_GROUP_ADDRESS`; trusts the rest in batches (default 10) with retry logic
* Supports dry-run logging, verbose logging, and optional Slack notifications for start, shutdown, and errors
* Runs every 10 minutes

### OIC App

* Monitors **AffiliateGroupChanged** events for trust relationship updates
* Calculates desired trustees by intersecting:
  * Addresses trusted by any MetaOrg trustee
  * Current affiliates in the registry
* Performs batch trust/untrust operations to reconcile differences
* Supports incremental scanning to avoid re-processing old events
* Can run in dry-run mode for testing without making transactions
* Configurable refresh intervals and batch sizes

## Operational notes

### General
* Make sure private keys control the appropriate **service** roles; otherwise transactions will fail
* Slack notifications are best-effort; failures may throw and crash the process
* Services are designed to fail loudly on errors and require a supervisor to monitor and restart
* Replace placeholder values (`your_private_key_here`, etc.) with actual values in Docker commands

### CRC Backers App
* `SERVICE_PRIVATE_KEY` must control the backers group's **service** role
* If you change the factory address, bump `START_AT_BLOCK` accordingly
* Service is stateless and does not store data between runs

### GP CRC App
* `GP_CRC_GROUP_ADDRESS` must match the group you intend to automatically trust new avatars into
* Provide `GP_CRC_SERVICE_PRIVATE_KEY` (or `SERVICE_PRIVATE_KEY`) with the group's **service** role unless `DRY_RUN=1`
* `METRI_SAFE_GRAPHQL_URL` is required; add `METRI_SAFE_API_KEY` if the endpoint is restricted
* `DRY_RUN=1` will log intended trust batches without submitting transactions

### OIC App  
* `OIC_SERVICE_PRIVATE_KEY` (or `SERVICE_PRIVATE_KEY`) must control the OIC group's **service** role
* `OIC_META_ORG_ADDRESS` is required - this is the MetaOrg whose trustees will be monitored
* Use `OIC_DRY_RUN=1` for testing without making actual blockchain transactions
* Service maintains incremental state to avoid re-processing old events

### Gnosis Group App
* Fetches registered human avatars and filters out blacklisted addresses
* Calls a relative trust scoring service to rank avatars by configured targets
* `GNOSIS_GROUP_DRY_RUN=1` (or `DRY_RUN=1`) skips blacklist and scoring service calls while logging the batches that would be requested

### Docker Notes
* The Dockerfile uses `APP_NAME` build argument to determine which app to run
* Environment variables can be passed directly with `-e` flags instead of using `.env` files
* The container runs as the `node` user for security
