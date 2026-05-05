import { useState, useEffect } from "react";
import { Loader2, X, Building2, CheckCircle2, ShieldCheck, ArrowRight } from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { toast } from "sonner";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";

export function SetupCompanyModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { publicKey, signMessage } = useWallet();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setSuccess(false);
      setName("");
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleClose = () => {
    setSuccess(false);
    setName("");
    onClose();
  };

  const handleCreate = async () => {
    if (!publicKey) {
      toast.error("Wallet not connected");
      return;
    }
    if (!signMessage) {
      toast.error("Wallet does not support message signing");
      return;
    }
    if (!name.trim()) {
      toast.error("Company name is required");
      return;
    }

    setLoading(true);
    try {
      const res = await walletAuthenticatedFetch({
        wallet: publicKey.toBase58(),
        signMessage,
        path: "/api/company/create",
        method: "POST",
        body: {
          name: name.trim(),
          employerWallet: publicKey.toBase58(),
        },
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to create company");
      }

      setSuccess(true);
      toast.success("Company setup complete!");
      
      // Call onSuccess after a brief delay to show success state
      setTimeout(() => {
        onSuccess();
        handleClose();
      }, 2000);
    } catch (err: any) {
      toast.error(`Setup failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={handleClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-md rounded-[2.5rem] border border-white/10 bg-[#0a0a0a] p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleClose}
          className="absolute right-6 top-6 rounded-xl p-2 text-[#a8a8aa] transition-colors hover:bg-white/5 hover:text-white"
        >
          <X size={18} />
        </button>

        {success ? (
          <div className="flex flex-col items-center text-center py-6">
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10">
              <CheckCircle2 size={40} className="text-emerald-400" />
            </div>
            <h2 className="mb-2 text-2xl font-bold tracking-tight text-white">Setup Complete</h2>
            <p className="text-sm text-[#a8a8aa]">
              Your company treasury has been securely created.
            </p>
            <Loader2 size={24} className="mt-8 animate-spin text-[#1eba98]" />
          </div>
        ) : (
          <>
            <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5 mx-auto">
              <Building2 size={28} className="text-white" />
            </div>

            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold tracking-tight text-white mb-2">Setup Company</h2>
              <p className="text-sm text-[#a8a8aa]">
                Create your private payroll treasury to start paying employees securely.
              </p>
            </div>

            <div className="space-y-4 mb-8">
              <div className="rounded-2xl border border-white/5 bg-[#111111] p-4">
                <label className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">
                  Admin Wallet
                </label>
                <div className="font-mono text-sm text-white truncate opacity-50">
                  {publicKey?.toBase58() || "Not connected"}
                </div>
              </div>

              <div className="rounded-2xl border border-white/5 bg-[#111111] p-4 focus-within:border-[#1eba98]/50 focus-within:bg-[#1eba98]/5 transition-colors">
                <label className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-[#a8a8aa]">
                  Company Name
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="e.g. Acme Corp"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-transparent text-lg font-semibold text-white placeholder-white/20 outline-none"
                    autoFocus
                  />
                </div>
              </div>
            </div>

            <div className="mb-8 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 flex gap-3">
              <ShieldCheck size={20} className="text-emerald-400 shrink-0" />
              <p className="text-xs text-emerald-400/80 leading-relaxed">
                We will automatically generate and secure a dedicated MagicBlock Ephemeral Treasury for your company.
              </p>
            </div>

            <button
              onClick={handleCreate}
              disabled={loading || !name.trim()}
              className="group flex w-full items-center justify-center gap-2 rounded-2xl bg-[#1eba98] py-4 text-sm font-bold text-black transition-all hover:bg-[#1eba98]/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  Create Treasury
                  <ArrowRight size={18} className="transition-transform group-hover:translate-x-1" />
                </>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
