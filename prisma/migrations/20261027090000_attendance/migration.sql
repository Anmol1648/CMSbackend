-- CreateTable
CREATE TABLE "holidays" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "for_students" BOOLEAN NOT NULL DEFAULT true,
    "for_staff" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_sheets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "slot" TEXT NOT NULL DEFAULT 'day',
    "marked_by" UUID,
    "marked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "attendance_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_marks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "sheet_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status_id" UUID NOT NULL,
    "note" TEXT,

    CONSTRAINT "attendance_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_attendance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "check_in" TIMESTAMPTZ(6),
    "check_out" TIMESTAMPTZ(6),
    "status_id" UUID,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "early_out" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'button',
    "check_in_ip" TEXT,
    "check_out_ip" TEXT,
    "note" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "staff_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "holidays_tenant_id_date_key" ON "holidays"("tenant_id", "date");

-- CreateIndex
CREATE INDEX "attendance_sheets_tenant_id_date_idx" ON "attendance_sheets"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_sheets_id_tenant_id_key" ON "attendance_sheets"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_sheets_tenant_id_section_id_date_slot_key" ON "attendance_sheets"("tenant_id", "section_id", "date", "slot");

-- CreateIndex
CREATE INDEX "attendance_marks_tenant_id_student_id_idx" ON "attendance_marks"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_marks_sheet_id_student_id_key" ON "attendance_marks"("sheet_id", "student_id");

-- CreateIndex
CREATE INDEX "staff_attendance_tenant_id_date_idx" ON "staff_attendance"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attendance_tenant_id_staff_id_date_key" ON "staff_attendance"("tenant_id", "staff_id", "date");

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_sheets" ADD CONSTRAINT "attendance_sheets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_sheets" ADD CONSTRAINT "attendance_sheets_section_id_tenant_id_fkey" FOREIGN KEY ("section_id", "tenant_id") REFERENCES "sections"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_sheet_id_tenant_id_fkey" FOREIGN KEY ("sheet_id", "tenant_id") REFERENCES "attendance_sheets"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_student_id_tenant_id_fkey" FOREIGN KEY ("student_id", "tenant_id") REFERENCES "students"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_status_id_tenant_id_fkey" FOREIGN KEY ("status_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_staff_id_tenant_id_fkey" FOREIGN KEY ("staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_status_id_tenant_id_fkey" FOREIGN KEY ("status_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
