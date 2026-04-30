# Expaynse

### Private Payroll and Private Payments on Solana

Expaynse is a proof-of-concept showing how to build employer-signed private payroll and private payment flows on Solana with the **MagicBlock Private Payment API**, employer wallet signatures, and app-side metadata.

For private-to-private payroll, each employee must go through a **one-time self-initialization** step from their own wallet before the first private payroll tick can transfer funds into that employee's private balance.

---

## ⚡ The Product

### For Disbursers (Senders)
- **CSV Support**: Upload payment files with `amount` and `address` fields.
- **The 2-Signature Win**: Send funds to 1 or 100 people with just **two wallet interactions** (1 for deposit, 1 for batch transfer).
- **Employer-Signed Payroll**: Employers build and sign onboarding, control, and tick transactions from the app UI.
- **Employee Self-Init**: Each employee initializes their own private payroll account once from the Claim page before the first private-to-private payroll transfer.
- **Data Sovereignty**: Download history in **JSON** with transaction signatures and clear your local records anytime.

### For Recipients (Claimers)
- **Private Balance**: View your confidential balance held in the ephemeral rollup.
- **Custom Withdrawals**: Withdraw the full amount or a specific portion—this helps obscure the original payment amount from outside observers.
- **Record Keeping**: Download JSON claim history and clear it from the dashboard.

---

## 🛡️ Privacy & Logic

- **Breaking Trails**: Effectively removes the direct link between the sender and receiver on the public blockchain.
- **Hiding Amounts**: By giving recipients the option to withdraw specific amounts, the original disburser figure stays obscured.
- **Private-to-Private Requirement**: A first-time employee recipient must initialize their own private payroll account before the employer can send payroll from private balance to private balance.
- **Split Responsibility**: The employer performs PER onboarding, while the employee performs the one-time private account setup from the Claim page.
- **App + Chain Architecture**: Private state lives in MagicBlock, while the app stores operational metadata and history for payroll UX.

---

## ⛽ Fees & Future

- **Currently**: Disbursers pay for depositing; recipients pay gas for withdrawing.
- **Future**: Integration with relayer services could enable completely gasless withdrawals for recipients.

---

## 💻 Local Setup

1.  **Install & Run**:
    ```bash
    git clone https://github.com/ajeeshRS/expaynse.git
    cd expaynse
    pnpm install && pnpm dev
    ```
2.  **Network**: Connect to **Solana Devnet**.
3.  **Employer Payroll Flow**:
    - create employee
    - create stream
    - click `Onboard PER`
    - ask the employee to open `Claim` and run the one-time `Initialize Private Account` step
    - run `Tick`
    - employee withdraws from private balance when ready

---

## 🔗 Tech

- **API**: MagicBlock Private Payment API (`lib/per-api.ts`)
- **Persistence**: Browser LocalStorage
- **Tools**: Next.js, PapaParse, Motion







