-- CreateTable
CREATE TABLE "hostels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "gender" TEXT NOT NULL DEFAULT 'mixed',
    "warden_id" UUID,
    "phone" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hostels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hostel_rooms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "hostel_id" UUID NOT NULL,
    "block" TEXT,
    "floor" INTEGER NOT NULL DEFAULT 0,
    "number" TEXT NOT NULL,
    "room_type_id" UUID,
    "beds" INTEGER NOT NULL DEFAULT 2,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "hostel_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hostel_allotments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "hostel_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "bed" INTEGER NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE,
    "status" TEXT NOT NULL DEFAULT 'active',
    "note" TEXT,
    "created_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hostel_allotments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hostel_roll_calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "hostel_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "marks" JSONB NOT NULL DEFAULT '{}',
    "taken_by" UUID,
    "taken_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "hostel_roll_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hostel_leaves" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "hostel_id" UUID NOT NULL,
    "from_at" TIMESTAMPTZ(6) NOT NULL,
    "to_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT NOT NULL,
    "escort" TEXT,
    "destination" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "pass_code" TEXT NOT NULL,
    "requested_by" UUID,
    "answered_by" UUID,
    "answered_at" TIMESTAMPTZ(6),
    "answer" TEXT,
    "out_at" TIMESTAMPTZ(6),
    "in_at" TIMESTAMPTZ(6),
    "late" BOOLEAN NOT NULL DEFAULT false,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hostel_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hostel_visitor_allows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT,
    "phone" TEXT,
    "added_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hostel_visitor_allows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hostel_medical" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "hostel_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "complaint" TEXT NOT NULL,
    "treatment" TEXT,
    "medicine" TEXT,
    "referred" BOOLEAN NOT NULL DEFAULT false,
    "parent_told" BOOLEAN NOT NULL DEFAULT false,
    "recorded_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "hostel_medical_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hostel_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "hostel_id" UUID NOT NULL,
    "room_id" UUID,
    "student_id" UUID,
    "academic_year_id" UUID,
    "kind" TEXT NOT NULL DEFAULT 'inspection',
    "note" TEXT NOT NULL,
    "fine" INTEGER,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "hostel_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hostels_id_tenant_id_key" ON "hostels"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "hostel_rooms_id_tenant_id_key" ON "hostel_rooms"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "hostel_rooms_hostel_id_number_key" ON "hostel_rooms"("hostel_id", "number");

-- CreateIndex
CREATE INDEX "hostel_allotments_tenant_id_room_id_status_idx" ON "hostel_allotments"("tenant_id", "room_id", "status");

-- CreateIndex
CREATE INDEX "hostel_allotments_tenant_id_student_id_idx" ON "hostel_allotments"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "hostel_roll_calls_hostel_id_date_key" ON "hostel_roll_calls"("hostel_id", "date");

-- CreateIndex
CREATE INDEX "hostel_leaves_tenant_id_status_idx" ON "hostel_leaves"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hostel_leaves_tenant_id_pass_code_key" ON "hostel_leaves"("tenant_id", "pass_code");

-- CreateIndex
CREATE INDEX "hostel_visitor_allows_tenant_id_student_id_idx" ON "hostel_visitor_allows"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "hostel_medical_tenant_id_student_id_idx" ON "hostel_medical"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "hostel_notes_tenant_id_hostel_id_idx" ON "hostel_notes"("tenant_id", "hostel_id");

-- AddForeignKey
ALTER TABLE "hostels" ADD CONSTRAINT "hostels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hostel_rooms" ADD CONSTRAINT "hostel_rooms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hostel_rooms" ADD CONSTRAINT "hostel_rooms_hostel_id_tenant_id_fkey" FOREIGN KEY ("hostel_id", "tenant_id") REFERENCES "hostels"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hostel_allotments" ADD CONSTRAINT "hostel_allotments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hostel_roll_calls" ADD CONSTRAINT "hostel_roll_calls_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hostel_leaves" ADD CONSTRAINT "hostel_leaves_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hostel_visitor_allows" ADD CONSTRAINT "hostel_visitor_allows_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hostel_medical" ADD CONSTRAINT "hostel_medical_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hostel_notes" ADD CONSTRAINT "hostel_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
