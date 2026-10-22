-- CreateTable
CREATE TABLE "leave_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "quota" DOUBLE PRECISION,
    "credit" TEXT NOT NULL DEFAULT 'yearly',
    "prorate" BOOLEAN NOT NULL DEFAULT true,
    "carry_forward" TEXT NOT NULL DEFAULT 'none',
    "carry_max" DOUBLE PRECISION,
    "half_day" BOOLEAN NOT NULL DEFAULT true,
    "min_days" DOUBLE PRECISION,
    "max_days" DOUBLE PRECISION,
    "notice_days" INTEGER NOT NULL DEFAULT 0,
    "back_days" INTEGER NOT NULL DEFAULT 7,
    "certificate_after" DOUBLE PRECISION,
    "overdraw" TEXT NOT NULL DEFAULT 'block',
    "sandwich" BOOLEAN NOT NULL DEFAULT false,
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "counts_present" BOOLEAN NOT NULL DEFAULT false,
    "attendance_code" TEXT NOT NULL DEFAULT 'LV',
    "staff_type_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "employment_type_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "gender_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "approval" TEXT NOT NULL DEFAULT 'default',
    "is_comp_off" BOOLEAN NOT NULL DEFAULT false,
    "comp_off_days" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "year_start" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "days" DOUBLE PRECISION NOT NULL,
    "worked_on" DATE,
    "expires_on" DATE,
    "note" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "leave_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_leaves" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "half" TEXT,
    "days" DOUBLE PRECISION NOT NULL,
    "lwp_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "attachment_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stage" INTEGER NOT NULL DEFAULT 1,
    "applied_by" UUID,
    "first_by" UUID,
    "first_at" TIMESTAMPTZ(6),
    "first_note" TEXT,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "staff_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_tenant_id_code_key" ON "leave_types"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_id_tenant_id_key" ON "leave_types"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "leave_entries_tenant_id_staff_id_year_start_idx" ON "leave_entries"("tenant_id", "staff_id", "year_start");

-- CreateIndex
CREATE INDEX "staff_leaves_tenant_id_staff_id_from_date_idx" ON "staff_leaves"("tenant_id", "staff_id", "from_date");

-- CreateIndex
CREATE INDEX "staff_leaves_tenant_id_status_idx" ON "staff_leaves"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_entries" ADD CONSTRAINT "leave_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_entries" ADD CONSTRAINT "leave_entries_staff_id_tenant_id_fkey" FOREIGN KEY ("staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_entries" ADD CONSTRAINT "leave_entries_leave_type_id_tenant_id_fkey" FOREIGN KEY ("leave_type_id", "tenant_id") REFERENCES "leave_types"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_leaves" ADD CONSTRAINT "staff_leaves_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_leaves" ADD CONSTRAINT "staff_leaves_staff_id_tenant_id_fkey" FOREIGN KEY ("staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_leaves" ADD CONSTRAINT "staff_leaves_leave_type_id_tenant_id_fkey" FOREIGN KEY ("leave_type_id", "tenant_id") REFERENCES "leave_types"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
