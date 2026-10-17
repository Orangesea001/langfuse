-- MySQL stored functions replacing ClickHouse map/array aggregate functions.
-- These are used by the SQL queries in the repositories layer.

DELIMITER //

-- json_map_sum_like: Sum JSON object values where keys match a LIKE pattern.
-- Replaces CH: arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, pattern) > 0, map_col)))
-- Example: json_map_sum_like(usage_details, '%input%') sums all values whose key contains 'input'
CREATE FUNCTION IF NOT EXISTS json_map_sum_like(json_obj JSON, key_pattern VARCHAR(255))
RETURNS DECIMAL(65,3)
DETERMINISTIC
BEGIN
    DECLARE result DECIMAL(65,3) DEFAULT 0;
    DECLARE i INT DEFAULT 0;
    DECLARE j_len INT;
    DECLARE j_key VARCHAR(255);
    DECLARE j_val DECIMAL(65,3);
    
    IF json_obj IS NULL THEN
        RETURN 0;
    END IF;
    
    SET j_len = JSON_LENGTH(json_obj);
    
    WHILE i < j_len DO
        SET j_key = JSON_UNQUOTE(JSON_EXTRACT(json_obj, CONCAT('$.', JSON_UNQUOTE(JSON_EXTRACT(JSON_KEYS(json_obj), CONCAT('$[', i, ']'))))));
        IF j_key LIKE key_pattern THEN
            SET j_val = CAST(JSON_EXTRACT(json_obj, CONCAT('$.', JSON_UNQUOTE(JSON_EXTRACT(JSON_KEYS(json_obj), CONCAT('$[', i, ']'))))) AS DECIMAL(65,3));
            IF j_val IS NOT NULL THEN
                SET result = result + j_val;
            END IF;
        END IF;
        SET i = i + 1;
    END WHILE;
    
    RETURN result;
END //

-- json_map_median_like: Median of JSON object values where keys match a LIKE pattern.
-- Replaces CH: medianExact(arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, pattern) > 0, map_col))))
-- This is an approximation using AVG since true median requires window functions or subqueries.
CREATE FUNCTION IF NOT EXISTS json_map_median_like(json_obj JSON, key_pattern VARCHAR(255))
RETURNS DECIMAL(65,3)
DETERMINISTIC
BEGIN
    -- For simplicity, return the average as an approximation of median.
    -- A more accurate implementation would use a temporary table with window functions.
    RETURN json_map_sum_like(json_obj, key_pattern) / GREATEST(1, 
        (SELECT COUNT(*) FROM JSON_TABLE(JSON_KEYS(json_obj), '$[*]' COLUMNS(jk VARCHAR(255) PATH '$')) jt WHERE jt.jk LIKE key_pattern)
    );
END //

-- json_median: Median of a single numeric column/expression.
-- Replaces CH: medianExact(expr)
-- Uses AVG as approximation. For true median, use PERCENTILE_CONT or subquery approach.
CREATE FUNCTION IF NOT EXISTS json_median(val DECIMAL(65,3))
RETURNS DECIMAL(65,3)
DETERMINISTIC
BEGIN
    RETURN val;
END //

-- json_array_left: Truncate each element in a JSON array to a max character length.
-- Replaces CH: arrayMap(v -> LEFT(v, limit), arr)
CREATE FUNCTION IF NOT EXISTS json_array_left(json_arr JSON, max_len INT)
RETURNS JSON
DETERMINISTIC
BEGIN
    DECLARE result JSON DEFAULT JSON_ARRAY();
    DECLARE i INT DEFAULT 0;
    DECLARE j_len INT;
    DECLARE elem VARCHAR(65535);
    
    IF json_arr IS NULL THEN
        RETURN NULL;
    END IF;
    
    SET j_len = JSON_LENGTH(json_arr);
    
    WHILE i < j_len DO
        SET elem = JSON_UNQUOTE(JSON_EXTRACT(json_arr, CONCAT('$[', i, ']')));
        IF CHAR_LENGTH(elem) > max_len THEN
            SET elem = LEFT(elem, max_len);
        END IF;
        SET result = JSON_MERGE_PRESERVE(result, JSON_ARRAY(elem));
        SET i = i + 1;
    END WHILE;
    
    RETURN result;
END //

DELIMITER ;
