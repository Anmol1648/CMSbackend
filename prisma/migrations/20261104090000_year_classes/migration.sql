-- CreateTable
CREATE TABLE "year_classes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "admissions_open" BOOLEAN NOT NULL DEFAULT true,
    "seats" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "year_classes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "year_classes_tenant_id_academic_year_id_idx" ON "year_classes"("tenant_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "year_classes_academic_year_id_class_id_key" ON "year_classes"("academic_year_id", "class_id");

-- AddForeignKey
ALTER TABLE "year_classes" ADD CONSTRAINT "year_classes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "year_classes" ADD CONSTRAINT "year_classes_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "year_classes" ADD CONSTRAINT "year_classes_class_id_tenant_id_fkey" FOREIGN KEY ("class_id", "tenant_id") REFERENCES "classes"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Fill it from what each session already has (nothing changes for existing sessions): every class
-- with sections, subjects, fees, timetable loads or enquiries in a session runs in it; sessions still
-- open also get every active class (a class without sections yet keeps showing in their dropdowns).
INSERT INTO "year_classes" ("tenant_id", "academic_year_id", "class_id", "updated_at")
SELECT DISTINCT x.tenant_id, x.academic_year_id, x.class_id, CURRENT_TIMESTAMP FROM (
    SELECT tenant_id, academic_year_id, class_id FROM "sections"
    UNION SELECT tenant_id, academic_year_id, class_id FROM "class_subjects"
    UNION SELECT tenant_id, academic_year_id, class_id FROM "fee_structure_lines"
    UNION SELECT tenant_id, academic_year_id, class_id FROM "tt_loads"
    UNION SELECT tenant_id, academic_year_id, class_id FROM "enquiries"
    UNION SELECT y.tenant_id, y.id, c.id FROM "academic_years" y JOIN "classes" c ON c.tenant_id = y.tenant_id AND c.is_active WHERE y.status = 'open'
) x
ON CONFLICT ("academic_year_id", "class_id") DO NOTHING;
