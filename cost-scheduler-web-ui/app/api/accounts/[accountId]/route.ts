import { NextRequest, NextResponse } from 'next/server';
import { AccountService } from '@/lib/account-service';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ accountId: string }> }
) {
    try {
        const { accountId } = await params;
        console.log('API - GET /api/accounts/[accountId] - Fetching account:', accountId);

        const account = await AccountService.getAccount(accountId);

        if (!account) {
            return NextResponse.json({
                success: false,
                error: 'Account not found'
            }, { status: 404 });
        }

        console.log('API - Successfully fetched account:', accountId);
        return NextResponse.json({
            success: true,
            data: account
        });
    } catch (error) {
        console.error('API - Error fetching account:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to fetch account'
        }, { status: 500 });
    }
}

export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ accountId: string }> }
) {
    try {
        const { accountId } = await params;
        console.log('API - PUT /api/accounts/[accountId] - Updating account:', accountId);

        const updateData = await request.json();
        console.log('API - Update data:', updateData);

        await AccountService.updateAccount(accountId, updateData);

        console.log('API - Successfully updated account:', accountId);
        return NextResponse.json({
            success: true,
            message: 'Account updated successfully'
        });
    } catch (error) {
        console.error('API - Error updating account:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update account'
        }, { status: 500 });
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ accountId: string }> }
) {
    try {
        const { accountId } = await params;
        console.log('API - DELETE /api/accounts/[accountId] - Deleting account:', accountId);

        await AccountService.deleteAccount(accountId);

        console.log('API - Successfully deleted account:', accountId);
        return NextResponse.json({
            success: true,
            message: 'Account deleted successfully'
        });
    } catch (error) {
        console.error('API - Error deleting account:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete account'
        }, { status: 500 });
    }
}
