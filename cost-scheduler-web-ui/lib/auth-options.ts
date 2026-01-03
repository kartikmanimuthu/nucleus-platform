import { NextAuthOptions } from "next-auth";
import CognitoProvider from "next-auth/providers/cognito";

export const authOptions: NextAuthOptions = {
    providers: [
        CognitoProvider({
            clientId: process.env.COGNITO_APP_CLIENT_ID as string,
            clientSecret: process.env.COGNITO_APP_CLIENT_SECRET as string,
            issuer: process.env.COGNITO_ISSUER as string,
        })
    ],
    pages: {
        signIn: '/login',
        error: '/login',
    },
    callbacks: {
        async jwt({ token, account, user }) {
            // Initial sign in
            if (account && user) {
                // Extract cognito groups from the id token
                if (account.id_token) {
                    try {
                        // Parse the JWT to get the 'cognito:groups' claim
                        const payload = JSON.parse(Buffer.from(
                            account.id_token.split('.')[1], 'base64'
                        ).toString());

                        // Add groups to the token
                        token.groups = payload["cognito:groups"] || [];
                        console.log('User groups:', token.groups);
                    } catch (error) {
                        console.error("Error parsing id token:", error);
                        token.groups = [];
                    }
                }
                return token;
            }

            // Return previous token if the access token has not expired yet
            return token;
        },
        async session({ session, token }) {
            // Add groups to the session
            session.user = session.user || {};
            session.user.groups = token.groups || [];
            return session;
        },
        async redirect({ url, baseUrl }) {
            // Allows relative callback URLs
            if (url.startsWith("/")) return `${baseUrl}${url}`;
            // Allows callback URLs on the same origin
            else if (new URL(url).origin === baseUrl) return url;
            return baseUrl;
        },
    },
    secret: process.env.NEXTAUTH_SECRET,
};
