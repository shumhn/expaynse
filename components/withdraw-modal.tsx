import { useState, useEffect } from "react";
import { Loader2, X, Wallet, CheckCircle2, ExternalLink, ShieldCheck } from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { withdraw, signAndSend, checkHealth } from "@/lib/magicblock-api";
import { toast } from "sonner";
import Link from "next/link";

export function WithdrawModal({ isOpen, onClose, baseBalance = 0, privateBalance = 0, onWithdrawSuccess }: { isOpen: boolean; onClose: () => void; baseBalance?: number; privateBalance?: number; onWithdrawSuccess?: () => void; }) {
  const { publicKey, signTransaction } = useWallet();
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [successSig, setSuccessSig] = useState<string | null>(null);
  const [withdrawnAmount, setWithdrawnAmount] = useState<number | null>(null);
  const [magicBlockHealth, setMagicBlockHealth] = useState<"checking" | "ok" | "error">("checking");

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setSuccessSig(null);
      setWithdrawnAmount(null);
      setAmount("");

      setMagicBlockHealth("checking");
      checkHealth()
        .then(res => setMagicBlockHealth(res.status === "ok" ? "ok" : "error"))
        .catch(() => setMagicBlockHealth("error"));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleClose = () => {
    setSuccessSig(null);
    setWithdrawnAmount(null);
    setAmount("");
    onClose();
  };

  const handleWithdraw = async () => {
    if (!publicKey || !signTransaction) {
      toast.error("Wallet not connected");
      return;
    }
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    if (val > privateBalance) {
      toast.error("Insufficient private vault balance");
      return;
    }

    setLoading(true);
    try {
      // Create withdraw transaction using MagicBlock
      const buildRes = await withdraw(
        publicKey.toBase58(),
        val,
      );

      if (!buildRes || !buildRes.transactionBase64) {
        throw new Error("Failed to build withdraw transaction");
      }

      const sig = await signAndSend(
        buildRes.transactionBase64,
        signTransaction
      );

      if (sig) {
        setSuccessSig(sig);
        setWithdrawnAmount(val);
        toast.success(`Successfully withdrew ${val} USDC`);
        if (onWithdrawSuccess) {
          onWithdrawSuccess();
        }
      }
    } catch (e: any) {
      console.error("Withdraw error:", e);
      toast.error(e.message || "Failed to withdraw. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div 
        className="bg-[#0b0f14] border border-white/10 rounded-3xl w-full max-w-md shadow-[0_30px_100px_rgba(0,0,0,0.5)] overflow-hidden flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-6 border-b border-white/5 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-red-500/10 to-transparent pointer-events-none" />
          <h2 className="text-xl font-bold text-white relative z-10">Withdraw Funds</h2>
          <button 
            onClick={handleClose}
            className="p-2 hover:bg-white/10 rounded-full transition-colors relative z-10"
          >
            <X size={20} className="text-[#a8a8aa]" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto overflow-x-hidden">
          {successSig ? (
            <div className="flex flex-col items-center justify-center py-6 animate-in fade-in zoom-in duration-300">
              <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mb-4">
                <CheckCircle2 size={32} className="text-emerald-500" />
              </div>
              <h3 className="text-2xl font-bold text-white mb-2">Withdrawal Successful!</h3>
              <p className="text-[#8f8f95] mb-6 text-center">
                {withdrawnAmount} USDC has been moved from your private vault to your base wallet.
              </p>
              
              <Link 
                href={`https://explorer.solana.com/tx/${successSig}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-xs font-bold text-[#1eba98] hover:text-[#1eba98]/80 transition-colors uppercase tracking-wider bg-[#1eba98]/10 px-4 py-2 rounded-xl"
              >
                View on Explorer <ExternalLink size={14} />
              </Link>
              
              <button
                onClick={handleClose}
                className="mt-8 w-full py-3 bg-white hover:bg-gray-200 text-black font-bold rounded-xl transition-colors uppercase tracking-widest text-xs"
              >
                Close
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-white/5 border border-white/10 rounded-2xl p-4 cursor-pointer hover:bg-white/10 transition-colors" onClick={() => setAmount(privateBalance.toString())}>
                  <p className="text-[10px] uppercase tracking-wider font-bold text-[#8f8f95] mb-1">Private Vault</p>
                  <p className="text-lg font-bold text-white tracking-tight">{privateBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-sm text-[#8f8f95]">USDC</span></p>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                  <p className="text-[10px] uppercase tracking-wider font-bold text-[#8f8f95] mb-1">Base Wallet</p>
                  <p className="text-lg font-bold text-white tracking-tight">{baseBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-sm text-[#8f8f95]">USDC</span></p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-[#8f8f95] mb-2 pl-1">
                  Amount to Withdraw (USDC)
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <span className="text-white font-bold">$</span>
                  </div>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-8 pr-20 text-white font-bold text-xl placeholder:text-white/20 focus:outline-none focus:border-[#1eba98] focus:ring-1 focus:ring-[#1eba98] transition-all"
                  />
                  <div className="absolute inset-y-0 right-2 flex items-center">
                    <button
                      onClick={() => setAmount(privateBalance.toString())}
                      className="px-3 py-1.5 bg-white/10 hover:bg-white/20 text-white text-[10px] font-bold uppercase tracking-wider rounded-lg transition-colors"
                    >
                      Max
                    </button>
                  </div>
                </div>
              </div>
              
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-start gap-3">
                <ShieldCheck size={20} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-500/80 leading-relaxed font-medium">
                  Withdrawing funds will move them out of your private enclave. They will become visible on the public Solana ledger.
                </p>
              </div>

              <div className="flex items-center gap-2 text-xs font-medium text-[#8f8f95] px-1">
                <div className={`w-2 h-2 rounded-full ${magicBlockHealth === 'ok' ? 'bg-[#1eba98]' : magicBlockHealth === 'error' ? 'bg-red-500' : 'bg-yellow-500 animate-pulse'}`} />
                {magicBlockHealth === 'ok' ? 'MagicBlock Encrypted RPC Online' : magicBlockHealth === 'error' ? 'MagicBlock RPC Offline' : 'Checking RPC Status...'}
              </div>

              <button
                onClick={handleWithdraw}
                disabled={loading || magicBlockHealth !== 'ok' || !amount}
                className="w-full py-4 bg-white hover:bg-gray-200 disabled:bg-white/10 disabled:text-[#8f8f95] text-black font-bold rounded-2xl transition-all shadow-[0_0_40px_rgba(255,255,255,0.1)] hover:shadow-[0_0_60px_rgba(255,255,255,0.2)] disabled:shadow-none uppercase tracking-widest text-xs flex items-center justify-center gap-2 active:scale-[0.98]"
              >
                {loading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Withdrawing...
                  </>
                ) : (
                  <>
                    <Wallet size={16} />
                    Confirm Withdrawal
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
