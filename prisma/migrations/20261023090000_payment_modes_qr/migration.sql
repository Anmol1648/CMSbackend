-- AlterTable
ALTER TABLE "online_payments" ADD COLUMN     "expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'checkout',
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'test',
ADD COLUMN     "qr_image_url" TEXT;

-- AlterTable
ALTER TABLE "payment_gateways" ADD COLUMN     "live_key_id" TEXT,
ADD COLUMN     "live_key_secret_enc" TEXT,
ADD COLUMN     "live_webhook_secret_enc" TEXT,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'test';

ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_mode_check" CHECK ("mode" IN ('test', 'live'));
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_mode_check" CHECK ("mode" IN ('test', 'live') AND "method" IN ('checkout', 'qr'));
