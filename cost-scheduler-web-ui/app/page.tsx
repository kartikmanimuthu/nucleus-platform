import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity,
  Calendar,
  DollarSign,
  Server,
  Users,
  TrendingDown,
} from "lucide-react";
import { SchedulesList } from "@/components/schedules/schedules-list";
import { AccountsList } from "@/components/accounts/accounts-list";
import { AuditLogs } from "@/components/audit/audit-logs";
import { formatDate } from "@/lib/date-utils";
// import { ClientAccountService } from "@/lib/client-account-service"; // Unused
import { AuditService } from "@/lib/audit-service";
import { UISchedule } from "@/lib/types";
import { AccountService } from "@/lib/account-service";
import { ScheduleService } from "@/lib/schedule-service";
// import { AuditDAL } from "@/lib/data-access/audit-dal";

// Mock data - replace with actual API calls
const mockStats = {
  totalSchedules: 24,
  activeSchedules: 18,
  totalAccounts: 8,
  monthlySavings: 12450,
  resourcesManaged: 156,
  lastExecution: "2024-01-15T10:30:00Z",
};

interface DashboardStats {
  totalSchedules: number;
  activeSchedules: number;
  totalAccounts: number;
  monthlySavings: number;
  resourcesManaged: number;
  lastExecution: string;
}

interface RecentActivity {
  id: string;
  action: string;
  schedule: string | null;
  account: string;
  timestamp: string;
  status: string;
}

// Server-side data fetching
async function getDashboardData(): Promise<{
  initialStats: DashboardStats;
  recentActivity: RecentActivity[];
  auditLogs: any[];
  schedules: UISchedule[];
  accounts: any[];
  error?: string;
}> {
  try {
    // Fetch accounts, schedules, and audit logs in parallel
    const [accounts, schedules, auditLogs] = await Promise.all([
      AccountService.getAccounts().catch(() => []),
      ScheduleService.getSchedules().catch(() => []),
      AuditService.getAuditLogs().catch(() => []),
    ]);

    // Calculate dashboard stats from real data
    const totalAccounts = accounts.length;
    const totalSchedules = schedules.length;
    const activeSchedules = schedules.filter((s) => s.active).length;
    const totalSavings = accounts.reduce(
      (sum, acc) => sum + (acc.monthlySavings || 0),
      0
    );
    const totalResources = accounts.reduce(
      (sum, acc) => sum + (acc.resourceCount || 0),
      0
    );

    const initialStats: DashboardStats = {
      totalSchedules,
      activeSchedules,
      totalAccounts,
      monthlySavings: totalSavings,
      resourcesManaged: totalResources,
      lastExecution: auditLogs[0]?.timestamp || new Date().toISOString(),
    };

    // Transform audit logs to recent activity format
    const recentActivity: RecentActivity[] = auditLogs
      .slice(0, 5)
      .map((log: any) => ({
        id: log.id,
        action: log.action,
        schedule: log.resourceType === "schedule" ? log.resource : null,
        account: log.accountId || log.resourceId || "Unknown",
        timestamp: log.timestamp,
        status: log.status,
      }));

    // Add fallback activity if no audit logs
    if (recentActivity.length === 0) {
      recentActivity.push({
        id: "fallback-1",
        action: "Dashboard loaded",
        schedule: null,
        account: "system",
        timestamp: new Date().toISOString(),
        status: "success",
      });
    }

    return {
      initialStats,
      recentActivity,
      auditLogs,
      schedules,
      accounts,
    };
  } catch (error) {
    console.error("Error fetching dashboard data:", error);

    // Return fallback data on error
    const fallbackStats: DashboardStats = {
      totalSchedules: 0,
      activeSchedules: 0,
      totalAccounts: 0,
      monthlySavings: 0,
      resourcesManaged: 0,
      lastExecution: new Date().toISOString(),
    };

    const fallbackActivity: RecentActivity[] = [
      {
        id: "error-1",
        action: "Failed to load dashboard data",
        schedule: null,
        account: "system",
        timestamp: new Date().toISOString(),
        status: "error",
      },
    ];

    return {
      initialStats: fallbackStats,
      recentActivity: fallbackActivity,
      auditLogs: [],
      error:
        error instanceof Error
          ? error.message
          : "Failed to load dashboard data",
      schedules: [],
      accounts: [],
    };
  }
}


export default async function Dashboard() {
  const { initialStats, recentActivity, auditLogs, error, schedules, accounts } =
    await getDashboardData();
  console.log(">> auditLOgs", auditLogs.length);

  if (error) {
    console.error("Dashboard error:", error);
  }

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6 bg-background">
      {/* Header */}
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight text-foreground">
          Cost Optimization Dashboard
        </h2>
      </div>

      {/* Server-rendered Stats Overview */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-card-foreground">
              Total Schedules
            </CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-card-foreground">
              {initialStats.totalSchedules}
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="text-green-600 dark:text-green-400">
                {initialStats.activeSchedules} active
              </span>
            </p>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-card-foreground">
              AWS Accounts
            </CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-card-foreground">
              {initialStats.totalAccounts}
            </div>
            <p className="text-xs text-muted-foreground">
              Across multiple regions
            </p>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-card-foreground">
              Monthly Savings
            </CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-card-foreground">
              ${initialStats.monthlySavings.toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">
              <TrendingDown className="inline h-3 w-3 text-green-600 dark:text-green-400" />{" "}
              +12% from last month
            </p>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-card-foreground">
              Resources Managed
            </CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-card-foreground">
              {initialStats.resourcesManaged}
            </div>
            <p className="text-xs text-muted-foreground">
              EC2, RDS, ECS, ElastiCache
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Server-rendered Recent Activity */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-card-foreground">
            Recent Activity
          </CardTitle>
          <CardDescription>
            Latest schedule executions and system events
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {recentActivity.map((activity) => (
              <div key={activity.id} className="flex items-center space-x-4">
                <div className="flex-shrink-0">
                  {activity.status === "success" ? (
                    <div className="h-2 w-2 bg-green-500 rounded-full" />
                  ) : (
                    <div className="h-2 w-2 bg-red-500 rounded-full" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-card-foreground">
                    {activity.action}
                    {activity.schedule && (
                      <span className="text-muted-foreground">
                        {" "}
                        - {activity.schedule}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Account: {activity.account} •{" "}
                    {/* {formatDate(activity.timestamp, { includeTime: true })} */}
                  </p>
                </div>
                <Badge
                  variant={
                    activity.status === "success" ? "default" : "destructive"
                  }
                  className={
                    activity.status === "success"
                      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100"
                      : ""
                  }
                >
                  {activity.status}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Main Content Tabs */}
      <Tabs defaultValue="audit" className="space-y-4">
        <TabsList className="bg-muted">
          <TabsTrigger
            value="schedules"
            className="data-[state=active]:bg-background"
          >
            Schedules
          </TabsTrigger>
          <TabsTrigger
            value="accounts"
            className="data-[state=active]:bg-background"
          >
            AWS Accounts
          </TabsTrigger>
          <TabsTrigger
            value="audit"
            className="data-[state=active]:bg-background"
          >
            Audit Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="schedules" className="space-y-4">
          <SchedulesList schedules={schedules} loading={false} error={error} />
        </TabsContent>

        <TabsContent value="accounts" className="space-y-4">
          <AccountsList accounts={accounts} loading={false} error={error} />
        </TabsContent>

        <TabsContent value="audit" className="space-y-4">
          <AuditLogs auditLogs={auditLogs} loading={false} error={error} />
        </TabsContent>
      </Tabs>
    </div>
  );
}