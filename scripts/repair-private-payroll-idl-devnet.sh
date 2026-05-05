#!/usr/bin/env sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORKSPACE_DIR="$ROOT_DIR/payroll1-rust"
ANCHOR_TOML_PATH="$WORKSPACE_DIR/Anchor.toml"
IDL_PATH="$WORKSPACE_DIR/target/idl/payroll.json"
PROGRAM_KEYPAIR_PATH="$WORKSPACE_DIR/target/deploy/payroll-keypair.json"
PROGRAM_ID="HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6"
DEFAULT_WALLET="/Users/sumangiri/Desktop/Homie/keys/payroll-authority.json"

usage() {
  cat <<EOF
Usage:
  sh expensee/scripts/repair-private-payroll-idl-devnet.sh [options]

Options:
  --build-first   Rebuild the payroll program before repairing the IDL
  --skip-close    Skip closing the existing canonical IDL account
  --print-only    Print the commands that would run, but do not execute them
  -h, --help      Show this help text

Required environment:
  ANCHOR_WALLET=/absolute/path/to/devnet-authority.json

What this script does:
  1. Optionally rebuilds the payroll Anchor workspace
  2. Closes the existing canonical on-chain IDL account for:
       $PROGRAM_ID
  3. Re-initializes the canonical IDL account from:
       $IDL_PATH
  4. Fetches the on-chain IDL to confirm the crank instructions are present

When to use this:
  - A deploy succeeded, but the IDL upload failed with a size-related Anchor error
  - The canonical on-chain IDL account is too small for the latest generated IDL

Important:
  - Closing the canonical IDL removes the on-chain IDL briefly until re-init completes
  - This does NOT change the deployed program binary
  - This assumes your wallet is both the program upgrade authority and IDL authority
EOF
}

log() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_file() {
  [ -f "$1" ] || fail "Missing required file: $1"
}

run_or_print() {
  if [ "$PRINT_ONLY" -eq 1 ]; then
    printf '[print-only] %s\n' "$*"
  else
    "$@"
  fi
}

print_wallet_info() {
  wallet_path=$1

  node -e '
    const fs = require("fs");
    const { Keypair } = require("@solana/web3.js");
    const path = process.argv[1];
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")));
    const kp = Keypair.fromSecretKey(secret);
    console.log(kp.publicKey.toBase58());
  ' "$wallet_path"
}

print_instruction_names() {
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const idl = JSON.parse(fs.readFileSync(path, "utf8"));
    for (const ix of idl.instructions || []) {
      console.log(ix.name);
    }
  ' "$1"
}

assert_instruction_in_file() {
  instruction_name=$1
  file_path=$2

  if ! grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$instruction_name\"" "$file_path"; then
    fail "Instruction $instruction_name not found in $file_path"
  fi
}

BUILD_FIRST=0
SKIP_CLOSE=0
PRINT_ONLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-first)
      BUILD_FIRST=1
      ;;
    --skip-close)
      SKIP_CLOSE=1
      ;;
    --print-only)
      PRINT_ONLY=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
  shift
done

require_command anchor
require_command node
require_command grep

require_file "$ANCHOR_TOML_PATH"
require_file "$PROGRAM_KEYPAIR_PATH"

ANCHOR_WALLET=${ANCHOR_WALLET:-$DEFAULT_WALLET}
require_file "$ANCHOR_WALLET"

if [ "$BUILD_FIRST" -eq 1 ]; then
  log "Building payroll workspace before IDL repair"
  if [ "$PRINT_ONLY" -eq 1 ]; then
    printf '[print-only] (cd %s && anchor build)\n' "$WORKSPACE_DIR"
  else
    (
      cd "$WORKSPACE_DIR"
      anchor build
    )
  fi
fi

require_file "$IDL_PATH"

log "Workspace summary"
printf 'Repo root: %s\n' "$ROOT_DIR"
printf 'Anchor workspace: %s\n' "$WORKSPACE_DIR"
printf 'Anchor wallet: %s\n' "$ANCHOR_WALLET"
printf 'Wallet pubkey: %s\n' "$(print_wallet_info "$ANCHOR_WALLET")"
printf 'Program id: %s\n' "$PROGRAM_ID"
printf 'IDL path: %s\n' "$IDL_PATH"

log "Validating generated local IDL contains crank instructions"
for instruction in \
  initialize_private_payroll \
  pay_salary \
  mark_private_transfer_paid \
  request_withdrawal \
  update_private_terms \
  pause_stream \
  resume_stream \
  stop_stream \
  checkpoint_accrual \
  schedule_checkpoint_accrual \
  cancel_checkpoint_accrual
do
  assert_instruction_in_file "$instruction" "$IDL_PATH"
done

printf 'Local IDL instruction names:\n'
print_instruction_names "$IDL_PATH"

if [ "$SKIP_CLOSE" -eq 0 ]; then
  log "Closing canonical on-chain IDL account"
  if [ "$PRINT_ONLY" -eq 1 ]; then
    printf '[print-only] (cd %s && anchor idl close %s --provider.cluster devnet --provider.wallet %s)\n' \
      "$WORKSPACE_DIR" \
      "$PROGRAM_ID" \
      "$ANCHOR_WALLET"
  else
    (
      cd "$WORKSPACE_DIR"
      anchor idl close "$PROGRAM_ID" \
        --provider.cluster devnet \
        --provider.wallet "$ANCHOR_WALLET"
    )
  fi
else
  log "Skipping IDL close step"
fi

log "Initializing canonical on-chain IDL account with fresh payroll IDL"
if [ "$PRINT_ONLY" -eq 1 ]; then
  printf '[print-only] (cd %s && anchor idl init %s --filepath %s --provider.cluster devnet --provider.wallet %s)\n' \
    "$WORKSPACE_DIR" \
    "$PROGRAM_ID" \
    "$IDL_PATH" \
    "$ANCHOR_WALLET"
else
  (
    cd "$WORKSPACE_DIR"
    anchor idl init "$PROGRAM_ID" \
      --filepath "$IDL_PATH" \
      --provider.cluster devnet \
      --provider.wallet "$ANCHOR_WALLET"
  )
fi

if [ "$PRINT_ONLY" -eq 1 ]; then
  log "Print-only mode complete"
  exit 0
fi

TMP_FETCHED_IDL="$WORKSPACE_DIR/target/idl/payroll.devnet.fetched.json"

log "Fetching canonical on-chain IDL for verification"
(
  cd "$WORKSPACE_DIR"
  anchor idl fetch "$PROGRAM_ID" \
    --provider.cluster devnet \
    --provider.wallet "$ANCHOR_WALLET" \
    > "$TMP_FETCHED_IDL"
)

for instruction in \
  initialize_private_payroll \
  pay_salary \
  mark_private_transfer_paid \
  request_withdrawal \
  update_private_terms \
  pause_stream \
  resume_stream \
  stop_stream \
  checkpoint_accrual \
  schedule_checkpoint_accrual \
  cancel_checkpoint_accrual
do
  assert_instruction_in_file "$instruction" "$TMP_FETCHED_IDL"
done

log "IDL repair completed successfully"
printf 'Fetched devnet IDL saved to: %s\n' "$TMP_FETCHED_IDL"
printf 'Verified crank instructions are now present on-chain.\n'

log "Verifying full local and on-chain payroll IDL parity"
(
  cd "$ROOT_DIR"
  ANCHOR_WALLET="$ANCHOR_WALLET" node scripts/check-payroll-idl-parity.js
)
