#!/usr/bin/env bash
# =============================================================================
# Langfuse MySQL Migration Runner
# =============================================================================
# Runs DDL and stored function migrations against a MySQL 8.0 instance.
#
# Usage:
#   ./migrate.sh                                    # Defaults: localhost:3306
#   ./migrate.sh -h myhost -P 3307 -u admin -p secret -d langfuse
#   ./migrate.sh --docker langfuse-mysql             # Run inside Docker container
#   ./migrate.sh --verify                            # Verify only, no changes
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Defaults
MYSQL_HOST="127.0.0.1"
MYSQL_PORT="3306"
MYSQL_USER="root"
MYSQL_PASSWORD=""
MYSQL_DATABASE="langfuse"
DOCKER_CONTAINER=""
VERIFY_ONLY=false
VERBOSE=false

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

usage() {
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  -h HOST       MySQL host (default: 127.0.0.1)"
  echo "  -P PORT       MySQL port (default: 3306)"
  echo "  -u USER       MySQL user (default: root)"
  echo "  -p PASSWORD   MySQL password"
  echo "  -d DATABASE   MySQL database (default: langfuse)"
  echo "  --docker CNT  Run inside Docker container named CNT"
  echo "  --verify      Verify setup only, don't run migrations"
  echo "  --verbose     Show SQL output"
  echo "  --help        Show this help"
  exit 0
}

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h) MYSQL_HOST="$2"; shift 2 ;;
    -P) MYSQL_PORT="$2"; shift 2 ;;
    -u) MYSQL_USER="$2"; shift 2 ;;
    -p) MYSQL_PASSWORD="$2"; shift 2 ;;
    -d) MYSQL_DATABASE="$2"; shift 2 ;;
    --docker) DOCKER_CONTAINER="$2"; shift 2 ;;
    --verify) VERIFY_ONLY=true; shift ;;
    --verbose) VERBOSE=true; shift ;;
    --help) usage ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# MySQL command helper
run_sql() {
  local sql="$1"
  if [[ -n "$DOCKER_CONTAINER" ]]; then
    docker exec -i "$DOCKER_CONTAINER" mysql -u "$MYSQL_USER" ${MYSQL_PASSWORD:+-p"$MYSQL_PASSWORD"} "$MYSQL_DATABASE" -e "$sql"
  else
    mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" ${MYSQL_PASSWORD:+-p"$MYSQL_PASSWORD"} "$MYSQL_DATABASE" -e "$sql"
  fi
}

run_sql_file() {
  local file="$1"
  if [[ -n "$DOCKER_CONTAINER" ]]; then
    docker exec -i "$DOCKER_CONTAINER" mysql -u "$MYSQL_USER" ${MYSQL_PASSWORD:+-p"$MYSQL_PASSWORD"} "$MYSQL_DATABASE" < "$file"
  else
    mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" ${MYSQL_PASSWORD:+-p"$MYSQL_PASSWORD"} "$MYSQL_DATABASE" < "$file"
  fi
}

# ---- Pre-flight checks ----
info "Pre-flight checks..."

# Check MySQL version
VERSION=$(run_sql "SELECT VERSION()" -sN 2>/dev/null || echo "unknown")
if [[ "$VERSION" == "unknown" ]]; then
  err "Cannot connect to MySQL"
  exit 1
fi
ok "MySQL version: $VERSION"

if [[ "$VERSION" != 8.* ]]; then
  warn "MySQL 8.0 is recommended. Detected: $VERSION"
fi

# Check charset
CHARSET=$(run_sql "SELECT DEFAULT_CHARACTER_SET_NAME FROM information_schema.schemata WHERE SCHEMA_NAME='$MYSQL_DATABASE'" -sN 2>/dev/null || echo "unknown")
if [[ "$CHARSET" == "utf8mb4" ]]; then
  ok "Database charset: utf8mb4"
else
  warn "Database charset is '$CHARSET', recommend utf8mb4"
fi

# ---- Verify mode ----
if [[ "$VERIFY_ONLY" == true ]]; then
  info "Verification mode — checking existing setup..."

  TABLES=$(run_sql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$MYSQL_DATABASE'" -sN 2>/dev/null)
  info "Tables: $TABLES (expected: 8)"

  FUNCS=$(run_sql "SELECT COUNT(*) FROM mysql.proc WHERE db='$MYSQL_DATABASE' AND type='FUNCTION'" -sN 2>/dev/null || echo "0")
  info "Stored functions: $FUNCS (expected: 4)"

  # List tables
  info "Tables:"
  run_sql "SELECT table_name, table_rows, ROUND(data_length/1024/1024, 2) AS 'size_mb' FROM information_schema.tables WHERE table_schema='$MYSQL_DATABASE' ORDER BY table_name" 2>/dev/null

  exit 0
fi

# ---- Run migrations ----
info "Running migrations..."

# Migration 001: Create tables
info "[1/2] Creating tables..."
if run_sql_file "$SCRIPT_DIR/001_create_tables.sql" 2>/dev/null; then
  ok "Tables created"
else
  err "Failed to create tables"
  exit 1
fi

# Migration 002: Create stored functions
info "[2/2] Creating stored functions..."
if run_sql_file "$SCRIPT_DIR/002_create_functions.sql" 2>/dev/null; then
  ok "Stored functions created"
else
  err "Failed to create stored functions"
  exit 1
fi

# ---- Post-migration verification ----
info "Verifying..."

TABLES=$(run_sql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$MYSQL_DATABASE'" -sN 2>/dev/null)
FUNCS=$(run_sql "SELECT COUNT(*) FROM mysql.proc WHERE db='$MYSQL_DATABASE' AND type='FUNCTION'" -sN 2>/dev/null || echo "0")

ok "Migration complete! Tables: $TABLES, Functions: $FUNCS"

if [[ "$VERBOSE" == true ]]; then
  echo ""
  info "Tables created:"
  run_sql "SHOW TABLES" 2>/dev/null
  echo ""
  info "Stored functions:"
  run_sql "SELECT name, param_list, returns FROM mysql.proc WHERE db='$MYSQL_DATABASE' AND type='FUNCTION'" 2>/dev/null || true
fi
