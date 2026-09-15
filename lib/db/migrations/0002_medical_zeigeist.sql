ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_account_id_idx" ON "account" USING btree ("issuer","account_id");