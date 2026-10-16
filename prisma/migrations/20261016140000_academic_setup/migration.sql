-- CreateEnum
CREATE TYPE "AcademicYearStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "SubjectAssessment" AS ENUM ('scholastic', 'co_scholastic');

-- CreateTable
CREATE TABLE "academic_years" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "status" "AcademicYearStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "academic_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "group_id" UUID,
    "has_streams" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "stream_id" UUID,
    "capacity" INTEGER,
    "room" TEXT,
    "class_teacher_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subjects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "type_id" UUID,
    "assessment" "SubjectAssessment" NOT NULL DEFAULT 'scholastic',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_subjects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "stream_id" UUID,
    "subject_id" UUID NOT NULL,
    "is_optional" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "class_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "academic_years_tenant_id_start_date_idx" ON "academic_years"("tenant_id", "start_date");

-- CreateIndex
CREATE UNIQUE INDEX "academic_years_id_tenant_id_key" ON "academic_years"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "classes_tenant_id_sort_order_idx" ON "classes"("tenant_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "classes_id_tenant_id_key" ON "classes"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "sections_tenant_id_academic_year_id_class_id_idx" ON "sections"("tenant_id", "academic_year_id", "class_id");

-- CreateIndex
CREATE UNIQUE INDEX "sections_id_tenant_id_key" ON "sections"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "subjects_tenant_id_sort_order_idx" ON "subjects"("tenant_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_id_tenant_id_key" ON "subjects"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "class_subjects_tenant_id_academic_year_id_class_id_idx" ON "class_subjects"("tenant_id", "academic_year_id", "class_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_tenant_id_key" ON "users"("id", "tenant_id");

-- AddForeignKey
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_group_id_tenant_id_fkey" FOREIGN KEY ("group_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_class_id_tenant_id_fkey" FOREIGN KEY ("class_id", "tenant_id") REFERENCES "classes"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_stream_id_tenant_id_fkey" FOREIGN KEY ("stream_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_class_teacher_id_tenant_id_fkey" FOREIGN KEY ("class_teacher_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_type_id_tenant_id_fkey" FOREIGN KEY ("type_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_class_id_tenant_id_fkey" FOREIGN KEY ("class_id", "tenant_id") REFERENCES "classes"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_stream_id_tenant_id_fkey" FOREIGN KEY ("stream_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_subject_id_tenant_id_fkey" FOREIGN KEY ("subject_id", "tenant_id") REFERENCES "subjects"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rules Prisma can't express ------------------------------------------------

-- At most one current year per school; names unique (case-insensitive).
CREATE UNIQUE INDEX "academic_years_current_key" ON "academic_years"("tenant_id") WHERE "is_current";
CREATE UNIQUE INDEX "academic_years_name_key" ON "academic_years"("tenant_id", lower("name"));
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_dates_check" CHECK ("end_date" > "start_date");
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_name_check" CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 40);

CREATE UNIQUE INDEX "classes_name_key" ON "classes"("tenant_id", lower("name"));
CREATE UNIQUE INDEX "classes_short_name_key" ON "classes"("tenant_id", lower("short_name")) WHERE "short_name" IS NOT NULL;
ALTER TABLE "classes" ADD CONSTRAINT "classes_name_check" CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 60);

-- One section of a name per class and year (VI-A once in 2026–27).
CREATE UNIQUE INDEX "sections_name_key" ON "sections"("tenant_id", "academic_year_id", "class_id", lower("name"));
ALTER TABLE "sections" ADD CONSTRAINT "sections_name_check" CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 20);
ALTER TABLE "sections" ADD CONSTRAINT "sections_capacity_check" CHECK ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 500);

CREATE UNIQUE INDEX "subjects_name_key" ON "subjects"("tenant_id", lower("name"));
CREATE UNIQUE INDEX "subjects_code_key" ON "subjects"("tenant_id", lower("code")) WHERE "code" IS NOT NULL;
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_name_check" CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 80);

-- A subject once per class, year and stream (empty stream = all streams).
CREATE UNIQUE INDEX "class_subjects_key" ON "class_subjects"("tenant_id", "academic_year_id", "class_id", COALESCE("stream_id", '00000000-0000-0000-0000-000000000000'::uuid), "subject_id");
