"use client"

import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Legend, Tooltip } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card"

const COLORS = ["#D9FF00", "#2775CA", "#FF3B30", "#F5A623", "#8A2BE2", "#FF1493", "#00CED1"];

export interface Employee {
  id: string;
  department?: string;
  monthlySalaryUsd?: number;
}

export interface Stream {
  employeeId: string;
  status: "active" | "paused" | "stopped";
  ratePerSecond: number;
}

interface CompensationChartProps {
  employees: Employee[];
  streams: Stream[];
}

function computeAllocation(employees: Employee[], streams: Stream[]) {
  const deptTotals: Record<string, number> = {};
  let total = 0;

  for (const emp of employees) {
    const stream = streams.find(s => s.employeeId === emp.id);
    if (stream && stream.status === "active") {
      // Estimate monthly from ratePerSecond
      const monthly = stream.ratePerSecond * 86400 * 30;
      const dept = emp.department || "Other";
      deptTotals[dept] = (deptTotals[dept] || 0) + monthly;
      total += monthly;
    }
  }

  if (total === 0) return [];

  return Object.entries(deptTotals)
    .filter(([, val]) => val > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, val], index) => ({
      name,
      value: Math.round((val / total) * 100),
      color: COLORS[index % COLORS.length],
      rawAmount: Math.round(val),
    }));
}

function CustomTooltip({
  active,
  payload,
}: { active?: boolean; payload?: Array<{ name: string; value: number; payload: { color: string; rawAmount: number } }> }) {
  if (active && payload && payload.length) {
    const data = payload[0];
    return (
      <div className="rounded-lg border border-white/10 bg-[#0a0a0a] p-3 shadow-md">
        <p className="text-sm font-medium text-white">{data.name}</p>
        <p className="text-sm font-bold" style={{ color: data.payload.color }}>
          {data.value}% <span className="text-xs font-normal text-[#a8a8aa] ml-1">(${data.payload.rawAmount.toLocaleString()})</span>
        </p>
      </div>
    )
  }
  return null
}

export function CompensationBreakdownChart({ employees, streams }: CompensationChartProps) {
  const data = useMemo(() => computeAllocation(employees, streams), [employees, streams]);
  const isMock = data.length === 0;

  // Fallback to empty state if no active streams
  const displayData = isMock 
    ? [{ name: "No Active Streams", value: 100, color: "#2a2a2a", rawAmount: 0 }] 
    : data;

  return (
    <Card className="relative">
      <CardHeader>
        <CardTitle>Burn by Department</CardTitle>
        <CardDescription>Breakdown of active streams by department</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[280px] w-full min-w-0 transition-opacity duration-300">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={280}>
            <PieChart>
              <Pie
                data={displayData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={90}
                paddingAngle={isMock ? 0 : 4}
                dataKey="value"
              >
                {displayData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} stroke="transparent" />
                ))}
              </Pie>
              {!isMock && <Tooltip content={<CustomTooltip />} />}
              {!isMock && (
                <Legend
                  verticalAlign="bottom"
                  formatter={(value) => <span className="text-[#a8a8aa] text-sm">{value}</span>}
                />
              )}
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
