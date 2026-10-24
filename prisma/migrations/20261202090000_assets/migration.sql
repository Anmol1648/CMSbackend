-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" UUID,
    "condition_id" UUID,
    "vendor_id" UUID,
    "room_id" UUID,
    "staff_id" UUID,
    "make" TEXT,
    "model" TEXT,
    "serial_no" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "purchased_on" DATE,
    "bill_no" TEXT,
    "cost" INTEGER,
    "warranty_until" DATE,
    "amc_until" DATE,
    "maintain_every" INTEGER,
    "next_maintenance_on" DATE,
    "photo_file_id" UUID,
    "bill_file_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'in_use',
    "disposed_on" DATE,
    "notes" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "from_room_id" UUID,
    "to_room_id" UUID,
    "from_staff_id" UUID,
    "to_staff_id" UUID,
    "cost" INTEGER,
    "note" TEXT,
    "user_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_issues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "photo_file_id" UUID,
    "reported_by" UUID,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigned_to" UUID,
    "vendor_id" UUID,
    "cost" INTEGER,
    "resolution" TEXT,
    "fixed_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "asset_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_disposals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "amount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "asked_by" UUID,
    "answered_by" UUID,
    "answered_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_disposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_by" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "asset_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_verification_found" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "verification_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "room_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_verification_found_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assets_tenant_id_room_id_idx" ON "assets"("tenant_id", "room_id");

-- CreateIndex
CREATE INDEX "assets_tenant_id_staff_id_idx" ON "assets"("tenant_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_id_tenant_id_key" ON "assets"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_tenant_id_code_key" ON "assets"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "asset_events_tenant_id_asset_id_at_idx" ON "asset_events"("tenant_id", "asset_id", "at");

-- CreateIndex
CREATE INDEX "asset_issues_tenant_id_status_idx" ON "asset_issues"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "asset_disposals_tenant_id_status_idx" ON "asset_disposals"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "asset_verifications_id_tenant_id_key" ON "asset_verifications"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_verification_found_verification_id_asset_id_key" ON "asset_verification_found"("verification_id", "asset_id");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_asset_id_tenant_id_fkey" FOREIGN KEY ("asset_id", "tenant_id") REFERENCES "assets"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_issues" ADD CONSTRAINT "asset_issues_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_issues" ADD CONSTRAINT "asset_issues_asset_id_tenant_id_fkey" FOREIGN KEY ("asset_id", "tenant_id") REFERENCES "assets"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_asset_id_tenant_id_fkey" FOREIGN KEY ("asset_id", "tenant_id") REFERENCES "assets"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_verifications" ADD CONSTRAINT "asset_verifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_verification_found" ADD CONSTRAINT "asset_verification_found_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_verification_found" ADD CONSTRAINT "asset_verification_found_verification_id_tenant_id_fkey" FOREIGN KEY ("verification_id", "tenant_id") REFERENCES "asset_verifications"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
