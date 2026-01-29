#!/usr/bin/env bun
/**
 * BudgetTracker.ts - Track Folding@Cloud costs and enforce budgets
 *
 * Commands:
 *   check            - Check current spend against budget
 *   estimate <hours> - Estimate cost for deployment
 *   log <amount>     - Log a cost entry
 *   reset            - Reset daily/monthly tracking
 *   report           - Generate cost report
 *
 * Usage:
 *   bun run BudgetTracker.ts check
 *   bun run BudgetTracker.ts estimate --workers 4 --hours 24
 */

import { $ } from "bun";
import * as fs from "fs";
import * as path from "path";

// Configuration from environment
const BUDGET_DAILY = parseFloat(process.env.FOLDING_BUDGET_DAILY || "5.00");
const BUDGET_MONTHLY = parseFloat(process.env.FOLDING_BUDGET_MONTHLY || "50.00");
const SKILL_DIR = path.dirname(import.meta.dir);
const TRACKING_FILE = path.join(SKILL_DIR, ".budget-tracking.json");

// Azure Spot VM pricing (approximate, varies by region and availability)
const VM_COSTS: Record<string, number> = {
  "Standard_D2s_v3": 0.02,   // ~$0.02/hr spot
  "Standard_D4s_v3": 0.04,   // ~$0.04/hr spot
  "Standard_D8s_v3": 0.08,   // ~$0.08/hr spot
  "Standard_B2s": 0.01,      // ~$0.01/hr spot
  "Standard_B4ms": 0.02,     // ~$0.02/hr spot
  "default": 0.03,           // Default estimate
};

interface CostEntry {
  timestamp: string;
  amount: number;
  provider: string;
  workers: number;
  hours: number;
  description: string;
}

interface BudgetTracking {
  dailySpend: number;
  monthlySpend: number;
  lastDailyReset: string;
  lastMonthlyReset: string;
  entries: CostEntry[];
}

/**
 * Load or initialize tracking data
 */
function loadTracking(): BudgetTracking {
  try {
    if (fs.existsSync(TRACKING_FILE)) {
      const data = JSON.parse(fs.readFileSync(TRACKING_FILE, "utf-8"));

      // Reset daily if new day
      const today = new Date().toISOString().split("T")[0];
      if (data.lastDailyReset !== today) {
        data.dailySpend = 0;
        data.lastDailyReset = today;
      }

      // Reset monthly if new month
      const thisMonth = new Date().toISOString().slice(0, 7);
      if (data.lastMonthlyReset !== thisMonth) {
        data.monthlySpend = 0;
        data.lastMonthlyReset = thisMonth;
      }

      return data;
    }
  } catch (error) {
    // File doesn't exist or is corrupted
  }

  const today = new Date().toISOString().split("T")[0];
  const thisMonth = new Date().toISOString().slice(0, 7);

  return {
    dailySpend: 0,
    monthlySpend: 0,
    lastDailyReset: today,
    lastMonthlyReset: thisMonth,
    entries: [],
  };
}

/**
 * Save tracking data
 */
function saveTracking(tracking: BudgetTracking): void {
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(tracking, null, 2));
}

/**
 * Check current spend against budgets
 */
function checkBudget(): { withinBudget: boolean; daily: any; monthly: any } {
  const tracking = loadTracking();

  const daily = {
    spent: tracking.dailySpend,
    budget: BUDGET_DAILY,
    remaining: BUDGET_DAILY - tracking.dailySpend,
    percent: (tracking.dailySpend / BUDGET_DAILY) * 100,
  };

  const monthly = {
    spent: tracking.monthlySpend,
    budget: BUDGET_MONTHLY,
    remaining: BUDGET_MONTHLY - tracking.monthlySpend,
    percent: (tracking.monthlySpend / BUDGET_MONTHLY) * 100,
  };

  const withinBudget = daily.remaining > 0 && monthly.remaining > 0;

  return { withinBudget, daily, monthly };
}

/**
 * Estimate cost for deployment
 */
function estimateCost(workers: number, hours: number, vmSize: string = "Standard_D2s_v3"): number {
  const hourlyRate = VM_COSTS[vmSize] || VM_COSTS["default"];
  return workers * hours * hourlyRate;
}

/**
 * Log a cost entry
 */
function logCost(amount: number, provider: string, workers: number, hours: number, description: string): void {
  const tracking = loadTracking();

  const entry: CostEntry = {
    timestamp: new Date().toISOString(),
    amount,
    provider,
    workers,
    hours,
    description,
  };

  tracking.entries.push(entry);
  tracking.dailySpend += amount;
  tracking.monthlySpend += amount;

  saveTracking(tracking);
}

/**
 * Generate cost report
 */
function generateReport(): string {
  const tracking = loadTracking();
  const budget = checkBudget();

  let report = `
# Folding@Cloud Cost Report
Generated: ${new Date().toISOString()}

## Budget Status

### Daily
- Spent: $${budget.daily.spent.toFixed(2)}
- Budget: $${budget.daily.budget.toFixed(2)}
- Remaining: $${budget.daily.remaining.toFixed(2)}
- Usage: ${budget.daily.percent.toFixed(1)}%

### Monthly
- Spent: $${budget.monthly.spent.toFixed(2)}
- Budget: $${budget.monthly.budget.toFixed(2)}
- Remaining: $${budget.monthly.remaining.toFixed(2)}
- Usage: ${budget.monthly.percent.toFixed(1)}%

## Recent Entries
`;

  const recentEntries = tracking.entries.slice(-10);
  if (recentEntries.length === 0) {
    report += "\nNo cost entries recorded yet.\n";
  } else {
    report += "\n| Date | Amount | Provider | Workers | Hours | Description |\n";
    report += "|------|--------|----------|---------|-------|-------------|\n";
    for (const entry of recentEntries) {
      const date = entry.timestamp.split("T")[0];
      report += `| ${date} | $${entry.amount.toFixed(2)} | ${entry.provider} | ${entry.workers} | ${entry.hours} | ${entry.description} |\n`;
    }
  }

  return report;
}

/**
 * Reset tracking
 */
function resetTracking(scope: "daily" | "monthly" | "all"): void {
  const tracking = loadTracking();

  if (scope === "daily" || scope === "all") {
    tracking.dailySpend = 0;
    tracking.lastDailyReset = new Date().toISOString().split("T")[0];
  }

  if (scope === "monthly" || scope === "all") {
    tracking.monthlySpend = 0;
    tracking.lastMonthlyReset = new Date().toISOString().slice(0, 7);
  }

  if (scope === "all") {
    tracking.entries = [];
  }

  saveTracking(tracking);
}

// =============================================================================
// Main CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(`
BudgetTracker - Track Folding@Cloud costs

Usage:
  bun run BudgetTracker.ts <command> [options]

Commands:
  check               Check current spend against budget
  estimate            Estimate deployment cost
  log                 Log a cost entry
  reset <scope>       Reset tracking (daily|monthly|all)
  report              Generate cost report

Options (estimate):
  --workers <n>       Number of workers (default: 1)
  --hours <n>         Hours to run (default: 1)
  --vm-size <size>    VM size (default: Standard_D2s_v3)

Options (log):
  --amount <n>        Cost amount
  --provider <name>   Provider (azure/aws/gcp)
  --workers <n>       Number of workers
  --hours <n>         Hours ran
  --desc <text>       Description

Environment:
  FOLDING_BUDGET_DAILY   Daily budget in USD (default: 5.00)
  FOLDING_BUDGET_MONTHLY Monthly budget in USD (default: 50.00)

Examples:
  bun run BudgetTracker.ts check
  bun run BudgetTracker.ts estimate --workers 4 --hours 24
  bun run BudgetTracker.ts log --amount 0.48 --provider azure --workers 2 --hours 12
`);
    process.exit(1);
  }

  switch (command) {
    case "check": {
      const budget = checkBudget();
      console.log(JSON.stringify(budget, null, 2));

      // Print alerts
      if (budget.daily.percent >= 100) {
        console.log("\n⚠️  DAILY BUDGET EXCEEDED - Scale down recommended");
      } else if (budget.daily.percent >= 80) {
        console.log("\n⚠️  Daily budget at 80% - monitor closely");
      }

      if (budget.monthly.percent >= 100) {
        console.log("\n⚠️  MONTHLY BUDGET EXCEEDED - Scale down recommended");
      } else if (budget.monthly.percent >= 80) {
        console.log("\n⚠️  Monthly budget at 80% - monitor closely");
      }

      process.exit(budget.withinBudget ? 0 : 1);
      break;
    }

    case "estimate": {
      const workersIdx = args.indexOf("--workers");
      const hoursIdx = args.indexOf("--hours");
      const vmIdx = args.indexOf("--vm-size");

      const workers = workersIdx !== -1 ? parseInt(args[workersIdx + 1]) : 1;
      const hours = hoursIdx !== -1 ? parseInt(args[hoursIdx + 1]) : 1;
      const vmSize = vmIdx !== -1 ? args[vmIdx + 1] : "Standard_D2s_v3";

      const cost = estimateCost(workers, hours, vmSize);
      const hourlyRate = VM_COSTS[vmSize] || VM_COSTS["default"];

      console.log(`
Cost Estimate:
  Workers: ${workers}
  Hours: ${hours}
  VM Size: ${vmSize}
  Hourly Rate: $${hourlyRate.toFixed(3)}/worker
  Total Estimate: $${cost.toFixed(2)}

Budget Impact:
  Daily remaining after: $${(BUDGET_DAILY - cost).toFixed(2)}
  Monthly remaining after: $${(BUDGET_MONTHLY - cost).toFixed(2)}
`);
      break;
    }

    case "log": {
      const amountIdx = args.indexOf("--amount");
      const providerIdx = args.indexOf("--provider");
      const workersIdx = args.indexOf("--workers");
      const hoursIdx = args.indexOf("--hours");
      const descIdx = args.indexOf("--desc");

      if (amountIdx === -1) {
        console.error("--amount is required");
        process.exit(1);
      }

      const amount = parseFloat(args[amountIdx + 1]);
      const provider = providerIdx !== -1 ? args[providerIdx + 1] : "unknown";
      const workers = workersIdx !== -1 ? parseInt(args[workersIdx + 1]) : 0;
      const hours = hoursIdx !== -1 ? parseFloat(args[hoursIdx + 1]) : 0;
      const desc = descIdx !== -1 ? args[descIdx + 1] : "Manual entry";

      logCost(amount, provider, workers, hours, desc);
      console.log(`Logged $${amount.toFixed(2)} to budget tracking`);
      break;
    }

    case "reset": {
      const scope = (args[1] || "daily") as "daily" | "monthly" | "all";
      resetTracking(scope);
      console.log(`Reset ${scope} tracking`);
      break;
    }

    case "report": {
      console.log(generateReport());
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
