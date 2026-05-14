#!/usr/bin/env sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORKSPACE_DIR="$ROOT_DIR"
IDL_PATH="$WORKSPACE_DIR/target/idl/payroll.json"
PROGRAM_SO_PATH="$WORKSPACE_DIR/target/deploy/payroll.so"
PROGRAM_KEYPAIR_PATH="$WORKSPACE_DIR/target/deploy/payroll-keypair.json"
ANCHOR_TOML_PATH="$WORKSPACE_DIR/Anchor.toml"
RUST_LIB_PATH="$WORKSPACE_DIR/programs/payroll/src/lib.rs"

EXPECTED_PROGRAM_ID="HoDcH6ocPxqHt5yEQGPAGrJZ9PgMp8LzU5gnEVBxNne6"
REQUIRED_INSTRUCTIONS="initialize_private_payroll pay_salary mark_private_transfer_paid request_withdrawal update_private_terms pause_stream resume_stream stop_stream schedule_checkpoint_accrual cancel_checkpoint_accrual checkpoint_accrual"

BUILD_ONLY=0
SKIP_VERIFY=0

usage() {
  cat <<EOF
Usage:
  sh expensee/scripts/deploy-private-payroll-devnet.sh [options]

Options:
  --build-only   Build the Anchor program and validate the IDL, but skip deploy
  --skip-verify  Skip post-deploy verification checks
  -h, --help     Show this help text

Required environment:
  ANCHOR_WALLET=/absolute/path/to/devnet-authority.json

What this script does:
  1. Verifies the workspace and wallet configuration
  2. Builds the payroll Anchor program
  3. Validates the generated IDL includes the private payroll lifecycle instructions
  4. Deploys the program to devnet
  5. Optionally runs the existing devnet verifier

Notes:
  - The program id is expected to remain:
      $EXPECTED_PROGRAM_ID
  - The app routes read the local IDL from:
      $IDL_PATH
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

assert_contains() {
  pattern=$1
  file=$2
  description=$3

  if ! grep -q "$pattern" "$file"; then
    fail "$description not found in $file"
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

validate_idl_instruction() {
  instruction_name=$1
  idl_file=$2

  if ! grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$instruction_name\"" "$idl_file"; then
    fail "IDL is missing instruction: $instruction_name"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-only)
      BUILD_ONLY=1
      ;;
    --skip-verify)
      SKIP_VERIFY=1
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
require_command solana
require_command node
require_command grep

require_file "$ANCHOR_TOML_PATH"
require_file "$RUST_LIB_PATH"

if [ -z "${ANCHOR_WALLET:-}" ]; then
  fail "ANCHOR_WALLET must be set to your devnet authority keypair path"
fi

require_file "$ANCHOR_WALLET"

log "Workspace summary"
printf 'Repo root: %s\n' "$ROOT_DIR"
printf 'Anchor workspace: %s\n' "$WORKSPACE_DIR"
printf 'Anchor wallet: %s\n' "$ANCHOR_WALLET"
printf 'Employer authority: %s\n' "$(print_wallet_info "$ANCHOR_WALLET")"

log "Verifying expected program id configuration"
assert_contains "$EXPECTED_PROGRAM_ID" "$ANCHOR_TOML_PATH" "Expected program id"
assert_contains "$EXPECTED_PROGRAM_ID" "$RUST_LIB_PATH" "Expected Rust declare_id"

log "Building payroll program"
(
  cd "$WORKSPACE_DIR"
  anchor build
)

require_file "$IDL_PATH"
require_file "$PROGRAM_SO_PATH"
require_file "$PROGRAM_KEYPAIR_PATH"

log "Validating generated IDL"
for instruction in $REQUIRED_INSTRUCTIONS; do
  validate_idl_instruction "$instruction" "$IDL_PATH"
done

printf 'Validated IDL: %s\n' "$IDL_PATH"
printf 'Validated binary: %s\n' "$PROGRAM_SO_PATH"
printf 'Validated keypair: %s\n' "$PROGRAM_KEYPAIR_PATH"

if [ "$BUILD_ONLY" -eq 1 ]; then
  log "Build-only mode complete"
  printf 'Next step:\n'
  printf '  (cd %s && anchor deploy --provider.cluster devnet)\n' "$WORKSPACE_DIR"
  exit 0
fi

log "Deploying payroll program to devnet"
(
  cd "$WORKSPACE_DIR"
  anchor deploy --provider.cluster devnet --provider.wallet "$ANCHOR_WALLET"
)

log "Printing deployed program details"
PROGRAM_ID_FROM_KEYPAIR=$(solana address -k "$PROGRAM_KEYPAIR_PATH")
printf 'Program id from keypair: %s\n' "$PROGRAM_ID_FROM_KEYPAIR"

if [ "$PROGRAM_ID_FROM_KEYPAIR" != "$EXPECTED_PROGRAM_ID" ]; then
  fail "Program keypair address does not match expected program id"
fi

PROGRAM_INFO_OUTPUT=$(solana program show "$EXPECTED_PROGRAM_ID" --url devnet || true)
printf '%s\n' "$PROGRAM_INFO_OUTPUT"

log "Verifying local and on-chain payroll IDL parity"
(
  cd "$ROOT_DIR"
  ANCHOR_WALLET="$ANCHOR_WALLET" node scripts/check-payroll-idl-parity.js
)

if [ "$SKIP_VERIFY" -eq 1 ]; then
  log "Skipping post-deploy verifier"
  exit 0
fi

log "Running existing devnet verifier"
(
  cd "$WORKSPACE_DIR"
  node scripts/payroll/verify-devnet.js
)

log "Deployment flow completed"
cat <<EOF
Done.

Recommended next checks:
  1. Run the app self-custodial e2e after exporting:
       ANCHOR_WALLET=$ANCHOR_WALLET
       MONGODB_URI=<your mongodb uri>
  2. From repo root, run:
       npm run test:app:self-custody
  3. If the app is using the local build artifact, confirm this file is current:
       $IDL_PATH
EOF
