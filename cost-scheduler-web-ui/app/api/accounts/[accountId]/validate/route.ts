import { NextRequest, NextResponse } from 'next/server';
import { AccountService } from '@/lib/account-service';

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ accountId: string }> }
) {
    try {
        const { accountId } = await params;
        console.log(`API - Validating account ${accountId}`);

        const result = await AccountService.validateAccount(accountId);

        return NextResponse.json({
            success: true,
            valid: result.connectionStatus === 'connected',
            data: result
        });
    } catch (error) {
        console.error('API - Error validating account:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to validate account'
        }, { status: 500 });
    }
}
