"use client";

import { useState } from "react";
import { X, Copy, CheckCircle2, ShieldAlert } from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { walletAuthenticatedFetch } from "@/lib/client/wallet-auth-fetch";

interface AuditorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AuditorModal({ isOpen, onClose }: AuditorModalProps) {
  const { publicKey, signMessage } = useWallet();
  const [copied, setCopied] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [expiresDays, setExpiresDays] = useState(30);

  if (!isOpen) return null;

  const handleGenerate = async () => {
    if (!publicKey || !signMessage) return;
    setIsGenerating(true);
    setError(null);

    try {
      const employerWallet = publicKey.toBase58();
      if (!employerWallet) throw new Error("Wallet not connected");
      const response = await walletAuthenticatedFetch({
        path: "/api/auditor-tokens",
        method: "POST",
        body: {
          employerWallet,
          label: label.trim() || undefined,
          expiresDays,
        },
        wallet: employerWallet,
        signMessage,
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to generate token");
      }

      const data = (await response.json()) as { token: { token: string } };
      setToken(data.token.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate token");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = () => {
    if (token) {
      const link = `${window.location.origin}/audit/${token}`;
      void navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    setToken(null);
    setError(null);
    setCopied(false);
    setLabel("");
    setExpiresDays(30);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div 
        className="bg-[#0b0f14] border border-white/10 rounded-3xl w-full max-w-md shadow-[0_30px_100px_rgba(0,0,0,0.5)] overflow-hidden flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-6 border-b border-white/5 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-[#1eba98]/10 to-transparent pointer-events-none" />
          <h2 className="text-xl font-bold text-white relative z-10">Auditor Access Link</h2>
          <button 
            onClick={handleClose}
            className="p-2 hover:bg-white/10 rounded-full transition-colors relative z-10"
          >
            <X size={20} className="text-[#a8a8aa]" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto overflow-x-hidden">
          <div className="mb-6 p-4 rounded-2xl bg-[#1eba98]/10 border border-[#1eba98]/20 flex gap-3">
            <ShieldAlert className="text-[#1eba98] shrink-0" size={20} />
            <div>
              <h4 className="text-sm font-bold text-[#1eba98] mb-1">Scoped Auditor Access</h4>
              <p className="text-xs text-[#a8a8aa]">
                This generates a scoped, read-only link. Auditors can review payroll evidence, activity history, and statement records without gaining transaction control.
              </p>
            </div>
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
              {error}
            </div>
          )}

          {!token ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#8f8f95]">
                  Link label
                </label>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="Q2 payroll audit"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-[#6f6f75] focus:border-[#1eba98]/30 focus:outline-none"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#8f8f95]">
                  Access window
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[7, 30, 90].map((days) => (
                    <button
                      key={days}
                      type="button"
                      onClick={() => setExpiresDays(days)}
                      className={`rounded-2xl border px-3 py-3 text-xs font-bold uppercase tracking-[0.16em] transition ${
                        expiresDays === days
                          ? "border-[#1eba98]/30 bg-[#1eba98]/10 text-[#1eba98]"
                          : "border-white/10 bg-white/5 text-[#a8a8aa] hover:bg-white/10"
                      }`}
                    >
                      {days} days
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={handleGenerate}
                disabled={isGenerating || !publicKey}
                className="w-full py-4 bg-white hover:bg-gray-200 disabled:bg-white/10 disabled:text-[#8f8f95] text-black font-bold rounded-2xl transition-all shadow-[0_0_40px_rgba(255,255,255,0.1)] hover:shadow-[0_0_60px_rgba(255,255,255,0.2)] disabled:shadow-none uppercase tracking-widest text-xs flex items-center justify-center gap-2 active:scale-[0.98]"
              >
                {isGenerating ? "Generating Secure Token..." : "Generate Access Link"}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-4 rounded-xl border border-white/10 bg-white/5 flex items-center justify-between gap-3">
                <div className="text-xs font-mono text-white truncate flex-1">
                  {window.location.origin}/audit/{token}
                </div>
                <button
                  onClick={handleCopy}
                  className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors shrink-0"
                >
                  {copied ? <CheckCircle2 size={16} className="text-[#1eba98]" /> : <Copy size={16} />}
                </button>
              </div>
              <p className="text-xs text-center text-[#8f8f95]">
                Send this link to your accountant or auditor. You can revoke this token at any time from the dashboard.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
