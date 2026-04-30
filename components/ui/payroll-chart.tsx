"use client"

import { useMemo } from "react";
import { Area, AreaChart, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip, ReferenceLine } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card"

interface RunwayChartProps {
  vaultBalance: number;
  monthlyBurnRate: number;
}

const EXPAYNSE_GREEN = "#D9FF00"
const EXPAYNSE_DARK = "#1A1D1A"
const EXPAYNSE_RED = "#FF3B30"

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function generateProjection(currentBalance: number, burnRate: number) {
  const data: Array<{ month: string; balance: number; isCritical: boolean }> = [];
  const now = new Date();
  
  let balance = currentBalance;
  for (let i = 0; i < 7; i++) { // Current month + next 6
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    data.push({
      month: MONTH_LABELS[d.getMonth()],
      balance: Math.max(0, balance),
      isCritical: balance < (burnRate * 1.5) // Less than 1.5 months runway
    });
    balance -= burnRate;
  }
  return data;
}

function CustomTooltip({
  active,
  payload,
  label,
}: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (active && payload && payload.length) {
    const val = payload[0].value;
    return (
      <div className="bg-[#0a0a0a] border border-white/10 rounded-xl px-3 py-2 shadow-sm">
        <p className="text-xs text-[#a8a8aa]/60">End of {label}</p>
        <p className="text-sm font-bold" style={{ color: val === 0 ? EXPAYNSE_RED : EXPAYNSE_GREEN }}>
          ${val.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
        </p>
      </div>
    )
  }
  return null
}

export function RunwayProjectionChart({ vaultBalance, monthlyBurnRate }: RunwayChartProps) {
  const isMock = monthlyBurnRate === 0;
  
  // If burn rate is 0 (mock), simulate a healthy $210k vault burning $35k/mo
  const displayBalance = isMock ? 210000 : vaultBalance;
  const displayBurnRate = isMock ? 35000 : monthlyBurnRate;

  const data = useMemo(() => generateProjection(displayBalance, displayBurnRate), [displayBalance, displayBurnRate]);

  return (
    <Card className="relative">
      <CardHeader>
        <CardTitle>Treasury Runway Projection</CardTitle>
        <CardDescription>Estimated vault depletion based on active streams</CardDescription>
      </CardHeader>
      <CardContent>
        {isMock && (
          <div className="absolute top-6 right-6 inline-flex items-center px-2.5 py-1 rounded-full border border-white/10 bg-white/5 text-[10px] font-bold tracking-wider text-[#a8a8aa] uppercase z-10">
            Example Data
          </div>
        )}
        <div className={`h-[280px] w-full min-w-0 transition-opacity duration-300 ${isMock ? 'pointer-events-none' : ''}`}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={280}>
            <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="runwayGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={EXPAYNSE_GREEN} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={EXPAYNSE_GREEN} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="criticalGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={EXPAYNSE_RED} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={EXPAYNSE_RED} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
              <XAxis
                dataKey="month"
                stroke="#a8a8aa"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                opacity={0.6}
                dy={10}
              />
              <YAxis
                stroke="#a8a8aa"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
                opacity={0.6}
                dx={-10}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="balance"
                stroke={data[data.length - 1].balance === 0 ? EXPAYNSE_RED : EXPAYNSE_GREEN}
                strokeWidth={3}
                fill={data[data.length - 1].balance === 0 ? "url(#criticalGradient)" : "url(#runwayGradient)"}
              />
              {/* Optional Refill Warning Line */}
              <ReferenceLine y={displayBurnRate * 1.5} stroke={EXPAYNSE_RED} strokeDasharray="3 3" opacity={0.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
