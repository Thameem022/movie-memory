import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { prisma } from "@/lib/prisma";

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    // With database sessions NextAuth passes the DB user here, but leaves its
    // id out of the session by default. The server needs it to scope every
    // query to the signed-in user.
    session({ session, user }) {
      return { ...session, user: { ...session.user, id: user.id } };
    },
  },
  // Send login errors to our own page instead of NextAuth's default one.
  pages: {
    signIn: "/login",
    error: "/login",
  },
  // Log only codes, messages and user IDs. NextAuth's error metadata can
  // include tokens and profile data, so it is not logged in full.
  logger: {
    error(code, metadata) {
      const message = metadata instanceof Error ? metadata.message : metadata.error?.message;
      console.error(`[auth] error ${code}: ${message}`);
    },
    warn(code) {
      console.warn(`[auth] warning ${code}`);
    },
  },
  events: {
    signIn({ user, isNewUser }) {
      console.info(`[auth] sign-in user=${user.id} new=${Boolean(isNewUser)}`);
    },
    signOut() {
      console.info("[auth] sign-out");
    },
  },
};
