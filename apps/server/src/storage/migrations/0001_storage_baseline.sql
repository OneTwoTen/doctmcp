-- M6.2 baseline: migration metadata được tạo trong transaction bootstrap.
-- Index này khóa tính duy nhất của tên migration, còn schema domain sẽ
-- được bổ sung bằng migrations version tiếp theo tại M6.3–M6.5.
CREATE UNIQUE INDEX idx_schema_migrations_name ON schema_migrations(name);
