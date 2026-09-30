-- Tracks whether we have proof the user controls their email address.
--
-- Password sign-ups are unverified (we send no verification mail yet); users
-- created through GitHub/Google have a provider-verified email. An unverified
-- account must never be silently merged with an OAuth identity that claims the
-- same email (pre-account-takeover) — see routes/auth.ts.

ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
UPDATE users SET email_verified = 1 WHERE provider IS NOT NULL;
