-- Payment modes and admission test results become masters: records keep the option's code.
-- The columns change type IN PLACE (enum → text), so every receipt's mode and every enquiry's test
-- result is kept ("cash" stays "cash").

-- Enquiries: test result and registration fee mode.
ALTER TABLE "enquiries" ALTER COLUMN "test_result" DROP DEFAULT;
ALTER TABLE "enquiries" ALTER COLUMN "test_result" SET DATA TYPE TEXT USING ("test_result"::text);
ALTER TABLE "enquiries" ALTER COLUMN "test_result" SET DEFAULT 'not_needed';
ALTER TABLE "enquiries" ALTER COLUMN "registration_fee_mode" SET DATA TYPE TEXT USING ("registration_fee_mode"::text);

-- Fee receipts: payment mode.
ALTER TABLE "fee_receipts" ALTER COLUMN "mode" SET DATA TYPE TEXT USING ("mode"::text);

-- The enums are no longer used.
DROP TYPE "PaymentMode";
DROP TYPE "TestResult";
