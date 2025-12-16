import { AuditLog, SearchParams } from "@/lib/types";
import { AuditService } from "@/lib/audit-service";
import AuditClient from "@/components/audit/audit-client-component";
import { AuditLogFilters } from "@/lib/audit-service";

interface AuditStats {
  totalLogs: number;
  errorCount: number;
  warningCount: number;
  successCount: number;
}

/**
 * Server component that fetches audit data directly from DynamoDB
 */
export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  // Extract filters from URL search params
  searchParams = await searchParams;
  const eventType = searchParams.eventType ? String(searchParams.eventType) : undefined;
  const status = searchParams.status ? String(searchParams.status) : undefined;
  const user = searchParams.user ? String(searchParams.user) : undefined;
  const startDate = searchParams.startDate ? String(searchParams.startDate) : undefined;
  const endDate = searchParams.endDate ? String(searchParams.endDate) : undefined;

  // Default to last 7 days if no dates are provided
  const defaultStartDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const defaultEndDate = new Date().toISOString();

  // Build filters from search params
  const filters: AuditLogFilters = {
    startDate: startDate || defaultStartDate,
    endDate: endDate || defaultEndDate,
  };
  
  // Add optional filters only if they're specified
  if (eventType && eventType !== 'all') filters.eventType = eventType;
  if (status && status !== 'all') filters.status = status;
  if (user && user !== 'all') filters.user = user;

  console.log('Server-side: Fetching audit logs with filters:', filters);
  
  // Fetch initial audit logs and stats from DynamoDB with filters
  const [logsResponse, statsResponse] = await Promise.all([
    AuditService.getAuditLogs(filters),
    AuditService.getAuditLogStats(filters),
  ]);

  // Map stats response to expected interface
  const mappedStats: AuditStats = {
    totalLogs: statsResponse.totalLogs || 0,
    errorCount: statsResponse.errorCount || 0,
    warningCount: statsResponse.warningCount || 0,
    successCount: statsResponse.successCount || 0,
  };

  // Create initialFilters object to pass to the client component
  const initialFilters = {
    eventType,
    status,
    user,
    startDate,
    endDate
  };

  return (
    <AuditClient 
      logsResponse={logsResponse.logs} 
      statsResponse={statsResponse}
      mappedStats={mappedStats}
      initialFilters={initialFilters}
    />
  );
}
