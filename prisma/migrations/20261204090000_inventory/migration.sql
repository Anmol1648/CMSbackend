-- CreateTable
CREATE TABLE "inv_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" UUID,
    "unit_id" UUID,
    "reorder_level" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reorder_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "barcode" TEXT,
    "sellable" BOOLEAN NOT NULL DEFAULT false,
    "sell_price" DOUBLE PRECISION,
    "track_expiry" BOOLEAN NOT NULL DEFAULT false,
    "gst_pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avg_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inv_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_stock" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "inv_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "batch_no" TEXT,
    "expiry_on" DATE,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inv_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_moves" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "department_id" UUID,
    "staff_id" UUID,
    "student_id" UUID,
    "ref_type" TEXT,
    "ref_id" UUID,
    "ref_no" TEXT,
    "note" TEXT,
    "user_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "inv_moves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "requested_by" UUID,
    "staff_id" UUID,
    "department_id" UUID,
    "store_id" UUID,
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "answered_by" UUID,
    "answered_at" TIMESTAMPTZ(6),
    "answer" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inv_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_request_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "issued_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "inv_request_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_purchase_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "vendor_id" UUID,
    "store_id" UUID,
    "order_date" DATE NOT NULL,
    "expected_on" DATE,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_by" UUID,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inv_purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_po_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "po_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "gst_pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "received_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "inv_po_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'po',
    "po_id" UUID,
    "vendor_id" UUID,
    "store_id" UUID NOT NULL,
    "bill_no" TEXT,
    "bill_date" DATE,
    "bill_file_id" UUID,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "note" TEXT,
    "received_by" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "inv_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_receipt_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "gst_pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "batch_no" TEXT,
    "expiry_on" DATE,

    CONSTRAINT "inv_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_adjustments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "item_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "batch_id" UUID,
    "qty" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "count_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "asked_by" UUID,
    "answered_by" UUID,
    "answered_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inv_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_counts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "store_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_by" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "inv_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_count_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "count_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "system_qty" DOUBLE PRECISION NOT NULL,
    "counted" DOUBLE PRECISION,

    CONSTRAINT "inv_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_sales" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "student_id" UUID NOT NULL,
    "academic_year_id" UUID,
    "store_id" UUID NOT NULL,
    "pay_at" TEXT NOT NULL DEFAULT 'fees',
    "mode" TEXT,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sold_by" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "inv_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_sale_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "inv_sale_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inv_items_id_tenant_id_key" ON "inv_items"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "inv_items_tenant_id_code_key" ON "inv_items"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "inv_stock_item_id_store_id_key" ON "inv_stock"("item_id", "store_id");

-- CreateIndex
CREATE INDEX "inv_batches_tenant_id_item_id_store_id_idx" ON "inv_batches"("tenant_id", "item_id", "store_id");

-- CreateIndex
CREATE INDEX "inv_moves_tenant_id_item_id_at_idx" ON "inv_moves"("tenant_id", "item_id", "at");

-- CreateIndex
CREATE INDEX "inv_moves_tenant_id_kind_at_idx" ON "inv_moves"("tenant_id", "kind", "at");

-- CreateIndex
CREATE INDEX "inv_requests_tenant_id_status_idx" ON "inv_requests"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inv_requests_id_tenant_id_key" ON "inv_requests"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "inv_purchase_orders_tenant_id_status_idx" ON "inv_purchase_orders"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inv_purchase_orders_id_tenant_id_key" ON "inv_purchase_orders"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "inv_receipts_id_tenant_id_key" ON "inv_receipts"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "inv_adjustments_tenant_id_status_idx" ON "inv_adjustments"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inv_counts_id_tenant_id_key" ON "inv_counts"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "inv_count_lines_count_id_item_id_key" ON "inv_count_lines"("count_id", "item_id");

-- CreateIndex
CREATE INDEX "inv_sales_tenant_id_student_id_idx" ON "inv_sales"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "inv_sales_id_tenant_id_key" ON "inv_sales"("id", "tenant_id");

-- AddForeignKey
ALTER TABLE "inv_items" ADD CONSTRAINT "inv_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock" ADD CONSTRAINT "inv_stock_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_stock" ADD CONSTRAINT "inv_stock_item_id_tenant_id_fkey" FOREIGN KEY ("item_id", "tenant_id") REFERENCES "inv_items"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_batches" ADD CONSTRAINT "inv_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_batches" ADD CONSTRAINT "inv_batches_item_id_tenant_id_fkey" FOREIGN KEY ("item_id", "tenant_id") REFERENCES "inv_items"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_moves" ADD CONSTRAINT "inv_moves_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_moves" ADD CONSTRAINT "inv_moves_item_id_tenant_id_fkey" FOREIGN KEY ("item_id", "tenant_id") REFERENCES "inv_items"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_requests" ADD CONSTRAINT "inv_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_request_lines" ADD CONSTRAINT "inv_request_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_request_lines" ADD CONSTRAINT "inv_request_lines_request_id_tenant_id_fkey" FOREIGN KEY ("request_id", "tenant_id") REFERENCES "inv_requests"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_purchase_orders" ADD CONSTRAINT "inv_purchase_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_po_lines" ADD CONSTRAINT "inv_po_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_po_lines" ADD CONSTRAINT "inv_po_lines_po_id_tenant_id_fkey" FOREIGN KEY ("po_id", "tenant_id") REFERENCES "inv_purchase_orders"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_receipts" ADD CONSTRAINT "inv_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_receipt_lines" ADD CONSTRAINT "inv_receipt_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_receipt_lines" ADD CONSTRAINT "inv_receipt_lines_receipt_id_tenant_id_fkey" FOREIGN KEY ("receipt_id", "tenant_id") REFERENCES "inv_receipts"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_adjustments" ADD CONSTRAINT "inv_adjustments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_counts" ADD CONSTRAINT "inv_counts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_count_lines" ADD CONSTRAINT "inv_count_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_count_lines" ADD CONSTRAINT "inv_count_lines_count_id_tenant_id_fkey" FOREIGN KEY ("count_id", "tenant_id") REFERENCES "inv_counts"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_sales" ADD CONSTRAINT "inv_sales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_sale_lines" ADD CONSTRAINT "inv_sale_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inv_sale_lines" ADD CONSTRAINT "inv_sale_lines_sale_id_tenant_id_fkey" FOREIGN KEY ("sale_id", "tenant_id") REFERENCES "inv_sales"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
