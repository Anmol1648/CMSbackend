-- CreateTable
CREATE TABLE "acc_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nature" TEXT NOT NULL,
    "parent_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "system_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_ledgers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "details" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "system_key" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_years" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "start" DATE NOT NULL,
    "end" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "openings" JSONB NOT NULL DEFAULT '{}',
    "budgets" JSONB NOT NULL DEFAULT '{}',
    "closed_at" TIMESTAMPTZ(6),
    "closed_by" UUID,

    CONSTRAINT "acc_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_vouchers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "narration" TEXT,
    "reference" TEXT,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "source_key" TEXT,
    "attachment_id" UUID,
    "created_by" UUID,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "voucher_id" UUID NOT NULL,
    "ledger_id" UUID NOT NULL,
    "dr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "note" TEXT,
    "reconciled_on" DATE,

    CONSTRAINT "acc_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acc_groups_tenant_id_system_key_key" ON "acc_groups"("tenant_id", "system_key");

-- CreateIndex
CREATE INDEX "acc_ledgers_tenant_id_group_id_idx" ON "acc_ledgers"("tenant_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "acc_ledgers_id_tenant_id_key" ON "acc_ledgers"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "acc_ledgers_tenant_id_system_key_key" ON "acc_ledgers"("tenant_id", "system_key");

-- CreateIndex
CREATE UNIQUE INDEX "acc_years_tenant_id_start_key" ON "acc_years"("tenant_id", "start");

-- CreateIndex
CREATE INDEX "acc_vouchers_tenant_id_date_idx" ON "acc_vouchers"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "acc_vouchers_id_tenant_id_key" ON "acc_vouchers"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "acc_vouchers_tenant_id_source_key_key" ON "acc_vouchers"("tenant_id", "source_key");

-- CreateIndex
CREATE INDEX "acc_entries_tenant_id_ledger_id_idx" ON "acc_entries"("tenant_id", "ledger_id");

-- CreateIndex
CREATE INDEX "acc_entries_tenant_id_voucher_id_idx" ON "acc_entries"("tenant_id", "voucher_id");

-- AddForeignKey
ALTER TABLE "acc_groups" ADD CONSTRAINT "acc_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_ledgers" ADD CONSTRAINT "acc_ledgers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_years" ADD CONSTRAINT "acc_years_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_vouchers" ADD CONSTRAINT "acc_vouchers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_entries" ADD CONSTRAINT "acc_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_entries" ADD CONSTRAINT "acc_entries_voucher_id_tenant_id_fkey" FOREIGN KEY ("voucher_id", "tenant_id") REFERENCES "acc_vouchers"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_entries" ADD CONSTRAINT "acc_entries_ledger_id_tenant_id_fkey" FOREIGN KEY ("ledger_id", "tenant_id") REFERENCES "acc_ledgers"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
