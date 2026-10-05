CREATE TABLE sales (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_name TEXT NOT NULL,
                employee_role TEXT NOT NULL,
                total REAL NOT NULL,
                cash_tendered REAL NOT NULL,
                change_due REAL NOT NULL,
                completed_at INTEGER NOT NULL
            , employee_id INTEGER REFERENCES employees(id), drawer_id INTEGER REFERENCES cash_drawers(id), total_cents INTEGER, tendered_cents INTEGER, buzzer TEXT NOT NULL DEFAULT '', order_note TEXT NOT NULL DEFAULT '', kitchen_status TEXT NOT NULL DEFAULT 'NONE', kitchen_updated INTEGER, checkout_key TEXT);
CREATE TABLE sale_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sale_id INTEGER NOT NULL,
                product_name TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                unit_price REAL NOT NULL, product_id INTEGER REFERENCES pos_products(id), price_cents INTEGER, kitchen INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
                FOREIGN KEY(sale_id)
                    REFERENCES sales(id)
            );
CREATE TABLE journal (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sale_id INTEGER,
                employee_name TEXT NOT NULL,
                event_type TEXT NOT NULL,
                details TEXT NOT NULL,
                amount REAL,
                created_at INTEGER NOT NULL
            , employee_id INTEGER REFERENCES employees(id));
CREATE TABLE inventory_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_name TEXT UNIQUE NOT NULL,
                quantity_on_hand REAL NOT NULL,
                unit TEXT NOT NULL
            , low_stock_level REAL NOT NULL DEFAULT 12, category TEXT NOT NULL DEFAULT 'BEER', package_size TEXT NOT NULL DEFAULT '', units_per_case INTEGER, cost_per_case REAL, cost_is_estimate INTEGER NOT NULL DEFAULT 1, supplier TEXT NOT NULL DEFAULT 'CRS OneSource', counted INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0, storage_location TEXT NOT NULL DEFAULT '', photo_data TEXT NOT NULL DEFAULT '');
CREATE TABLE inventory_movements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                inventory_item_id INTEGER NOT NULL,
                quantity_delta REAL NOT NULL,
                reason TEXT NOT NULL,
                employee_name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                sale_id INTEGER, employee_id INTEGER REFERENCES employees(id), before_quantity REAL, after_quantity REAL,
                FOREIGN KEY(inventory_item_id)
                    REFERENCES inventory_items(id)
            );
CREATE TABLE inventory_work (
            id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
            kind TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
            created_by INTEGER NOT NULL, created_name TEXT NOT NULL, created_at INTEGER NOT NULL,
            completed_by INTEGER, completed_name TEXT, completed_at INTEGER,
            FOREIGN KEY(item_id) REFERENCES inventory_items(id));
CREATE TABLE weekly_counts (
            id INTEGER PRIMARY KEY AUTOINCREMENT, count_date TEXT NOT NULL,
            event_label TEXT NOT NULL DEFAULT '', employee_id INTEGER NOT NULL,
            employee_name TEXT NOT NULL, created_at INTEGER NOT NULL, voided INTEGER NOT NULL DEFAULT 0);
CREATE TABLE weekly_lines (
            id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
            product_name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL,
            counted REAL NOT NULL, ordered REAL NOT NULL, received REAL NOT NULL,
            previous_count REAL, previous_date TEXT, estimated_usage REAL, before_stock REAL,
            before_counted INTEGER NOT NULL, stock_revision INTEGER NOT NULL, unit_cost REAL, cost_is_estimate INTEGER NOT NULL DEFAULT 1, review_flags TEXT NOT NULL DEFAULT '',
            UNIQUE(batch_id,item_id), FOREIGN KEY(batch_id) REFERENCES weekly_counts(id),
            FOREIGN KEY(item_id) REFERENCES inventory_items(id));
CREATE TABLE count_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT,employee_id INTEGER UNIQUE NOT NULL,
            count_date TEXT NOT NULL,event_label TEXT NOT NULL,data TEXT NOT NULL,updated_at INTEGER NOT NULL,
            FOREIGN KEY(employee_id) REFERENCES employees(id));
CREATE TABLE delivery_orders (id INTEGER PRIMARY KEY AUTOINCREMENT,item_id INTEGER NOT NULL,
            product_name TEXT NOT NULL,unit TEXT NOT NULL,supplier TEXT NOT NULL,ordered REAL NOT NULL CHECK(ordered>0),
            expected_date TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',closed INTEGER NOT NULL DEFAULT 0,
            employee_id INTEGER NOT NULL,employee_name TEXT NOT NULL,created_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(item_id) REFERENCES inventory_items(id));
CREATE TABLE delivery_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL,item_id INTEGER NOT NULL,
            product_name TEXT NOT NULL,unit TEXT NOT NULL,receipt_date TEXT NOT NULL,accepted REAL NOT NULL CHECK(accepted>=0),
            damaged REAL NOT NULL CHECK(damaged>=0),order_units REAL NOT NULL CHECK(order_units>=0),note TEXT NOT NULL DEFAULT '',
            cost_total REAL,cost_is_estimate INTEGER NOT NULL DEFAULT 1,credit_amount REAL,credit_status TEXT NOT NULL DEFAULT 'NONE',
            credit_note TEXT NOT NULL DEFAULT '',employee_id INTEGER NOT NULL,employee_name TEXT NOT NULL,created_at INTEGER NOT NULL,
            stock_applied INTEGER NOT NULL,FOREIGN KEY(order_id) REFERENCES delivery_orders(id),FOREIGN KEY(item_id) REFERENCES inventory_items(id));
CREATE TABLE recount_checks (id INTEGER PRIMARY KEY AUTOINCREMENT,flag_key TEXT UNIQUE NOT NULL,
            employee_id INTEGER NOT NULL,employee_name TEXT NOT NULL,checked_at INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '');
CREATE TABLE board_notes (id INTEGER PRIMARY KEY AUTOINCREMENT,month TEXT UNIQUE NOT NULL,
            note TEXT NOT NULL DEFAULT '',signed_name TEXT NOT NULL DEFAULT '',signed_at INTEGER,signature_hash TEXT NOT NULL DEFAULT '',employee_id INTEGER NOT NULL);
CREATE TABLE "employees" (id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('Manager','Staff')),
            pin TEXT UNIQUE NOT NULL,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE time_shifts (id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL,employee_name TEXT NOT NULL,clock_in INTEGER NOT NULL CHECK(clock_in>0),
            clock_out INTEGER CHECK(clock_out IS NULL OR clock_out>=clock_in),
            FOREIGN KEY(employee_id) REFERENCES employees(id));
CREATE TABLE pos_products (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,
            category TEXT NOT NULL,price_cents INTEGER NOT NULL CHECK(price_cents>=0 AND price_cents<=10000000),
            kitchen INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pos_recipes (id INTEGER PRIMARY KEY AUTOINCREMENT,product_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,quantity REAL NOT NULL CHECK(quantity>0),UNIQUE(product_id,item_id),
            FOREIGN KEY(product_id) REFERENCES pos_products(id),FOREIGN KEY(item_id) REFERENCES inventory_items(id));
CREATE TABLE cash_drawers (id INTEGER PRIMARY KEY AUTOINCREMENT,opened_at INTEGER NOT NULL,
            opened_by INTEGER NOT NULL,opened_name TEXT NOT NULL,opening_cents INTEGER NOT NULL CHECK(opening_cents>=0),
            closed_at INTEGER,closed_by INTEGER,closed_name TEXT,counted_cents INTEGER,expected_cents INTEGER,note TEXT NOT NULL DEFAULT '',
            FOREIGN KEY(opened_by) REFERENCES employees(id),FOREIGN KEY(closed_by) REFERENCES employees(id));
CREATE TABLE cash_entries (id INTEGER PRIMARY KEY AUTOINCREMENT,drawer_id INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('SALE','REFUND','VOID','PAID IN','PAID OUT')),amount_cents INTEGER NOT NULL,
            sale_id INTEGER,actor_name TEXT NOT NULL,note TEXT NOT NULL,created_at INTEGER NOT NULL,
            FOREIGN KEY(drawer_id) REFERENCES cash_drawers(id),FOREIGN KEY(sale_id) REFERENCES sales(id));
CREATE TABLE sale_stock (id INTEGER PRIMARY KEY AUTOINCREMENT,sale_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,quantity REAL NOT NULL CHECK(quantity>0),applied INTEGER NOT NULL,
            FOREIGN KEY(sale_id) REFERENCES sales(id),FOREIGN KEY(item_id) REFERENCES inventory_items(id));
CREATE TABLE sale_reversals (id INTEGER PRIMARY KEY AUTOINCREMENT,sale_id INTEGER UNIQUE NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('VOID','REFUND')),reason TEXT NOT NULL,stock_returned INTEGER NOT NULL,
            manager_id INTEGER NOT NULL,manager_name TEXT NOT NULL,created_at INTEGER NOT NULL,
            FOREIGN KEY(sale_id) REFERENCES sales(id),FOREIGN KEY(manager_id) REFERENCES employees(id));
CREATE TABLE time_changes (id INTEGER PRIMARY KEY AUTOINCREMENT,shift_id INTEGER NOT NULL,
            old_in INTEGER NOT NULL,old_out INTEGER,new_in INTEGER NOT NULL,new_out INTEGER,
            manager_id INTEGER NOT NULL,manager_name TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,
            FOREIGN KEY(shift_id) REFERENCES time_shifts(id),FOREIGN KEY(manager_id) REFERENCES employees(id));
CREATE UNIQUE INDEX weekly_active_date ON weekly_counts(count_date) WHERE voided=0;
CREATE UNIQUE INDEX one_open_shift ON time_shifts(employee_id) WHERE clock_out IS NULL;
CREATE UNIQUE INDEX single_open_drawer ON cash_drawers((1)) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX checkout_once ON sales(checkout_key) WHERE checkout_key IS NOT NULL;
CREATE UNIQUE INDEX sale_cash_once ON cash_entries(sale_id) WHERE kind='SALE';