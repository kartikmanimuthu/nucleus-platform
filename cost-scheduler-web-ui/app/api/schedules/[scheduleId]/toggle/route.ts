import { NextRequest, NextResponse } from 'next/server';
import { ScheduleService } from '@/lib/schedule-service';

// POST /api/schedules/[scheduleId]/toggle - Toggle schedule active status
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ scheduleId: string }> }
) {
    try {
        const { scheduleId } = await params;
        console.log('API Route - Toggling schedule status:', scheduleId);

        const updatedSchedule = await ScheduleService.toggleScheduleStatus(scheduleId);

        return NextResponse.json({
            success: true,
            data: updatedSchedule,
            message: `Schedule status toggled to ${updatedSchedule.active ? 'active' : 'inactive'}`
        });
    } catch (error) {
        console.error('API Route - Error toggling schedule status:', error);

        if (error instanceof Error && error.message === 'Schedule not found') {
            return NextResponse.json({
                success: false,
                error: error.message
            }, { status: 404 });
        }

        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to toggle schedule status'
        }, { status: 500 });
    }
}
