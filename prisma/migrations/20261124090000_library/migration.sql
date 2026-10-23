-- CreateTable
CREATE TABLE "books" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "authors" TEXT,
    "publisher" TEXT,
    "edition" TEXT,
    "year" INTEGER,
    "isbn" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'book',
    "category_id" UUID,
    "language_id" UUID,
    "location_id" UUID,
    "call_number" TEXT,
    "level" TEXT,
    "price" INTEGER,
    "pages" INTEGER,
    "keywords" TEXT,
    "cover_file_id" UUID,
    "file_id" UUID,
    "link" TEXT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book_copies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "accession_no" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "condition_id" UUID,
    "location_id" UUID,
    "acquired_on" DATE,
    "source" TEXT,
    "bill_no" TEXT,
    "price" INTEGER,
    "notes" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "book_copies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_loans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "copy_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "member_kind" TEXT NOT NULL,
    "student_id" UUID,
    "staff_id" UUID,
    "issued_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "returned_on" DATE,
    "renewals" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'out',
    "issued_by" UUID,
    "returned_by" UUID,
    "reminded_on" DATE,
    "note" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "member_kind" TEXT NOT NULL,
    "student_id" UUID,
    "staff_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "copy_id" UUID,
    "ready_at" TIMESTAMPTZ(6),
    "hold_until" DATE,
    "created_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_fines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "loan_id" UUID,
    "member_kind" TEXT NOT NULL,
    "student_id" UUID,
    "staff_id" UUID,
    "academic_year_id" UUID,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "waived" INTEGER NOT NULL DEFAULT 0,
    "waive_reason" TEXT,
    "waived_by" UUID,
    "pay_at" TEXT NOT NULL DEFAULT 'fees',
    "status" TEXT NOT NULL DEFAULT 'due',
    "paid_on" DATE,
    "received_by" UUID,
    "receipt_no" TEXT,
    "on" DATE NOT NULL,
    "note" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "library_fines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_stock_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "library_stock_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_stock_scans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "copy_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_stock_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "books_tenant_id_title_idx" ON "books"("tenant_id", "title");

-- CreateIndex
CREATE INDEX "books_tenant_id_isbn_idx" ON "books"("tenant_id", "isbn");

-- CreateIndex
CREATE UNIQUE INDEX "books_id_tenant_id_key" ON "books"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "book_copies_tenant_id_book_id_idx" ON "book_copies"("tenant_id", "book_id");

-- CreateIndex
CREATE UNIQUE INDEX "book_copies_id_tenant_id_key" ON "book_copies"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "book_copies_tenant_id_accession_no_key" ON "book_copies"("tenant_id", "accession_no");

-- CreateIndex
CREATE INDEX "library_loans_tenant_id_status_due_on_idx" ON "library_loans"("tenant_id", "status", "due_on");

-- CreateIndex
CREATE INDEX "library_loans_tenant_id_student_id_idx" ON "library_loans"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "library_loans_tenant_id_staff_id_idx" ON "library_loans"("tenant_id", "staff_id");

-- CreateIndex
CREATE INDEX "library_loans_tenant_id_book_id_idx" ON "library_loans"("tenant_id", "book_id");

-- CreateIndex
CREATE UNIQUE INDEX "library_loans_id_tenant_id_key" ON "library_loans"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "library_reservations_tenant_id_book_id_status_idx" ON "library_reservations"("tenant_id", "book_id", "status");

-- CreateIndex
CREATE INDEX "library_reservations_tenant_id_student_id_idx" ON "library_reservations"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "library_reservations_tenant_id_staff_id_idx" ON "library_reservations"("tenant_id", "staff_id");

-- CreateIndex
CREATE INDEX "library_fines_tenant_id_student_id_idx" ON "library_fines"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "library_fines_tenant_id_academic_year_id_pay_at_idx" ON "library_fines"("tenant_id", "academic_year_id", "pay_at");

-- CreateIndex
CREATE UNIQUE INDEX "library_stock_checks_id_tenant_id_key" ON "library_stock_checks"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "library_stock_scans_check_id_copy_id_key" ON "library_stock_scans"("check_id", "copy_id");

-- AddForeignKey
ALTER TABLE "books" ADD CONSTRAINT "books_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_copies" ADD CONSTRAINT "book_copies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_copies" ADD CONSTRAINT "book_copies_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "books"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_copy_id_tenant_id_fkey" FOREIGN KEY ("copy_id", "tenant_id") REFERENCES "book_copies"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_reservations" ADD CONSTRAINT "library_reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_fines" ADD CONSTRAINT "library_fines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_stock_checks" ADD CONSTRAINT "library_stock_checks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_stock_scans" ADD CONSTRAINT "library_stock_scans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_stock_scans" ADD CONSTRAINT "library_stock_scans_check_id_tenant_id_fkey" FOREIGN KEY ("check_id", "tenant_id") REFERENCES "library_stock_checks"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
