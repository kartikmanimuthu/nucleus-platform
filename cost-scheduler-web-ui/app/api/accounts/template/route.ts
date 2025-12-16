
import { NextRequest, NextResponse } from 'next/server';
import { generateOnboardingTemplate, generateOnboardingYaml } from '@/lib/cf-template-generator';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const targetAccountId = searchParams.get('targetAccountId') || undefined;
        const accountName = searchParams.get('accountName') || undefined;

        // In a real app, these would come from config or the current user's organization context
        const hubAccountId = process.env.NEXT_PUBLIC_HUB_ACCOUNT_ID || '044656767899'; // Defaulting to current dev account for now

        // Generate a random external ID for security (should be persisted in session or DB in real implementation)
        const externalId = 'nucleus-' + Math.random().toString(36).substring(2, 15);

        const template = generateOnboardingTemplate(hubAccountId, externalId, targetAccountId, accountName);
        const templateYaml = generateOnboardingYaml(hubAccountId, externalId, targetAccountId, accountName);

        return NextResponse.json({
            template,
            templateYaml,
            externalId
        });
    } catch (error) {
        console.error('Error generating template:', error);
        return NextResponse.json({ error: 'Failed to generate template' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { accountId, accountName, externalId: providedExternalId } = body;

        const hubAccountId = process.env.NEXT_PUBLIC_HUB_ACCOUNT_ID || '044656767899';

        // Use provided External ID (for edits) or generate new one (for creates)
        const externalId = providedExternalId || 'nucleus-' + Math.random().toString(36).substring(2, 15);

        const template = generateOnboardingTemplate(hubAccountId, externalId, accountId, accountName);
        const templateYaml = generateOnboardingYaml(hubAccountId, externalId, accountId, accountName);

        return NextResponse.json({
            success: true,
            template,
            templateYaml,
            externalId
        });
    } catch (error) {
        console.error('Error generating template:', error);
        return NextResponse.json({
            success: false,
            error: 'Failed to generate template'
        }, { status: 500 });
    }
}
