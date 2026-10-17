#!/usr/bin/env bash
# =============================================================================
# Langfuse MySQL Setup Script
# =============================================================================
# Interactive script to set up Langfuse with MySQL replacing ClickHouse.
# Follows aip's deployment pattern with Zebra Proxy support.
#
# Usage:
#   chmod +x scripts/setup-mysql.sh
#   ./scripts/setup-mysql.sh              # Interactive mode
#   ./scripts/setup-mysql.sh --env test   # Non-interactive: test environment
#   ./scripts/setup-mysql.sh --env prod   # Non-interactive: production
#   ./scripts/setup-mysql.sh --local      # Local dev with Docker MySQL
#   ./scripts/setup-mysql.sh --migrate    # Run migrations only
#   ./scripts/setup-mysql.sh --check      # Check current setup status
# =============================================================================

set -eo pipefail

# ---- Colors ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ---- Defaults ----
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
MIGRATION_DIR="$PROJECT_ROOT/packages/shared/src/server/mysql/migrations"

# Zebra defaults (following aip's pattern)
DEFAULT_APP_NAME="com.sankuai.t0.langfuse"
DEFAULT_ZEBRA_PROXY_HOST="zebra-proxy.internal"

# MySQL defaults for local dev
DEFAULT_MYSQL_HOST="127.0.0.1"
DEFAULT_MYSQL_PORT="3306"
DEFAULT_MYSQL_USER="langfuse"
DEFAULT_MYSQL_PASSWORD="langfuse"
DEFAULT_MYSQL_DB="langfuse"

# ---- Functions ----

get_ref_key() {
  local env_name=$(echo "$1" | tr "[:upper:]" "[:lower:]")
  case "$env_name" in
    production) echo "bjintel_langfuse_product" ;;
    staging)    echo "bjintel_langfuse_staging" ;;
    test)       echo "bjintel_langfuse_test" ;;
    development) echo "bjintel_langfuse_dev" ;;
    prod)       echo "bjintel_langfuse_product" ;;
    dev)        echo "bjintel_langfuse_dev" ;;
    *)
      err "Unknown environment: $1"
      err "Valid options: production, staging, test, development, prod, dev"
      exit 1
      ;;
  esac
}

check_prerequisites() {
  info "Checking prerequisites..."

  # Check docker
  if command -v docker &>/dev/null; then
    ok "Docker found: $(docker --version)"
  else
    warn "Docker not found. Needed for local MySQL container."
  fi

  # Check docker compose
  if docker compose version &>/dev/null 2>&1; then
    ok "Docker Compose found: $(docker compose version --short 2>/dev/null || echo 'v2')"
  else
    warn "Docker Compose v2 not found."
  fi

  # Check mysql client
  if command -v mysql &>/dev/null; then
    ok "MySQL client found: $(mysql --version 2>/dev/null | head -1)"
  else
    warn "MySQL client not found. Install for manual migration runs."
  fi

  # Check Node.js
  if command -v node &>/dev/null; then
    ok "Node.js found: $(node --version)"
  else
    err "Node.js not found. Required for running Langfuse."
    exit 1
  fi
}

check_mysql_connection() {
  local host="${1:-$DEFAULT_MYSQL_HOST}"
  local port="${2:-$DEFAULT_MYSQL_PORT}"
  local user="${3:-root}"
  local password="${4:-}"

  info "Testing MySQL connection to ${host}:${port}..."
  if mysql -h "$host" -P "$port" -u "$user" ${password:+-p"$password"} -e "SELECT 1" &>/dev/null 2>&1; then
    ok "MySQL connection successful"
    return 0
  else
    err "Cannot connect to MySQL at ${host}:${port}"
    return 1
  fi
}

run_migrations() {
  local host="${1:-$DEFAULT_MYSQL_HOST}"
  local port="${2:-$DEFAULT_MYSQL_PORT}"
  local user="${3:-root}"
  local password="${4:-}"
  local db="${5:-$DEFAULT_MYSQL_DB}"

  info "Running MySQL migrations..."

  # Migration 001: Create tables
  info "  [1/2] Creating tables (001_create_tables.sql)..."
  if mysql -h "$host" -P "$port" -u "$user" ${password:+-p"$password"} "$db" \
      < "$MIGRATION_DIR/001_create_tables.sql" 2>/dev/null; then
    ok "  Tables created successfully"
  else
    err "  Failed to create tables"
    return 1
  fi

  # Migration 002: Create stored functions
  info "  [2/2] Creating stored functions (002_create_functions.sql)..."
  if mysql -h "$host" -P "$port" -u "$user" ${password:+-p"$password"} "$db" \
      < "$MIGRATION_DIR/002_create_functions.sql" 2>/dev/null; then
    ok "  Stored functions created successfully"
  else
    err "  Failed to create stored functions"
    return 1
  fi

  ok "All migrations completed!"
}

verify_setup() {
  local host="${1:-$DEFAULT_MYSQL_HOST}"
  local port="${2:-$DEFAULT_MYSQL_PORT}"
  local user="${3:-root}"
  local password="${4:-}"
  local db="${5:-$DEFAULT_MYSQL_DB}"

  info "Verifying MySQL setup..."

  # Check tables exist
  local tables
  tables=$(mysql -h "$host" -P "$port" -u "$user" ${password:+-p"$password"} "$db" \
    -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$db'" -sN 2>/dev/null || echo "0")

  if [[ "$tables" -ge 8 ]]; then
    ok "Found $tables tables (expected >= 8)"
  else
    warn "Found only $tables tables (expected >= 8). Run migrations?"
    return 1
  fi

  # Check stored functions
  local funcs
  funcs=$(mysql -h "$host" -P "$port" -u "$user" ${password:+-p"$password"} "$db" \
    -e "SELECT COUNT(*) FROM mysql.proc WHERE db='$db' AND type='FUNCTION'" -sN 2>/dev/null || echo "0")

  if [[ "$funcs" -ge 4 ]]; then
    ok "Found $funcs stored functions (expected >= 4)"
  else
    warn "Found only $funcs stored functions (expected >= 4). Run migrations?"
  fi

  # Check MySQL version
  local version
  version=$(mysql -h "$host" -P "$port" -u "$user" ${password:+-p"$password"} \
    -e "SELECT VERSION()" -sN 2>/dev/null || echo "unknown")
  ok "MySQL version: $version"

  if [[ "$version" == 8.* ]]; then
    ok "MySQL 8.0 detected (recommended)"
  else
    warn "MySQL 8.0 is recommended, detected: $version"
  fi
}

start_local_mysql() {
  info "Starting local MySQL 8.0 container..."

  if ! docker ps --format '{{.Names}}' | grep -q 'langfuse-mysql' 2>/dev/null; then
    docker run -d \
      --name langfuse-mysql \
      -e MYSQL_ROOT_PASSWORD="$DEFAULT_MYSQL_PASSWORD" \
      -e MYSQL_DATABASE="$DEFAULT_MYSQL_DB" \
      -e MYSQL_USER="$DEFAULT_MYSQL_USER" \
      -e MYSQL_PASSWORD="$DEFAULT_MYSQL_PASSWORD" \
      -p 3306:3306 \
      mysql:8.0 \
      --max_connections=1000 \
      --innodb_buffer_pool_size=512M \
      --character_set_server=utf8mb4 \
      --collation_server=utf8mb4_unicode_ci \
      --default_authentication_plugin=mysql_native_password

    info "Waiting for MySQL to be ready..."
    local retries=30
    while ! docker exec langfuse-mysql mysqladmin ping -u root -p"$DEFAULT_MYSQL_PASSWORD" --silent &>/dev/null; do
      retries=$((retries - 1))
      if [[ $retries -eq 0 ]]; then
        err "MySQL container failed to start"
        exit 1
      fi
      sleep 1
    done
    ok "MySQL container is ready"
  else
    ok "MySQL container already running"
  fi
}

write_env_zebra() {
  local deploy_env="$1"
  local ref_key
  ref_key=$(get_ref_key "$deploy_env")

  info "Writing .env configuration for Zebra Proxy mode..."

  # Backup existing .env
  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
    info "Existing .env backed up"
  fi

  cat > "$ENV_FILE" << ENVEOF
# Auto-generated by setup-mysql.sh — Zebra Proxy mode
# Deployment: $deploy_env
# Generated: $(date -Iseconds)

# ---- PostgreSQL (primary DB) ----
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
DIRECT_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# ---- MySQL via Zebra Proxy ----
# LANGFUSE_MYSQL_URL is NOT set — Zebra Proxy handles connection routing
LANGFUSE_ZEBRA_APP_NAME="$DEFAULT_APP_NAME"
LANGFUSE_ZEBRA_REF_KEY="$ref_key"
LANGFUSE_ZEBRA_PROXY_HOST="$DEFAULT_ZEBRA_PROXY_HOST"
LANGFUSE_MYSQL_CONNECTION_LIMIT=25

# ---- Deployment ----
DEPLOY_ENV="$deploy_env"
ENVEOF
  ok ".env written for Zebra Proxy mode ($deploy_env → $ref_key)"
}

write_env_direct() {
  info "Writing .env configuration for direct MySQL mode..."

  # Backup existing .env
  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
    info "Existing .env backed up"
  fi

  cat > "$ENV_FILE" << ENVEOF
# Auto-generated by setup-mysql.sh — Direct MySQL mode
# Generated: $(date -Iseconds)

# ---- PostgreSQL (primary DB) ----
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
DIRECT_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# ---- MySQL (direct connection) ----
LANGFUSE_MYSQL_URL="mysql://$DEFAULT_MYSQL_USER:$DEFAULT_MYSQL_PASSWORD@localhost:3306/$DEFAULT_MYSQL_DB"
LANGFUSE_MYSQL_CONNECTION_LIMIT=25

# ---- Deployment ----
DEPLOY_ENV="DEVELOPMENT"
ENVEOF
  ok ".env written for direct MySQL mode"
}

show_status() {
  echo ""
  echo "=========================================="
  echo "  Langfuse MySQL Setup Status"
  echo "=========================================="
  echo ""

  # Check .env
  if [[ -f "$ENV_FILE" ]]; then
    ok ".env file exists"
    echo ""
    grep -E '^(LANGFUSE_MYSQL_URL|LANGFUSE_ZEBRA_|DEPLOY_ENV|LANGFUSE_MYSQL_CONNECTION_LIMIT)=' "$ENV_FILE" 2>/dev/null | \
      sed 's/\(.*PASSWORD.*=\)[^"]*/\1***/' | while IFS= read -r line; do
      echo "  $line"
    done
  else
    warn ".env file not found"
  fi

  echo ""

  # Check MySQL container
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'langfuse-mysql'; then
    ok "MySQL container is running"
    docker ps --filter "name=langfuse-mysql" --format "  Image: {{.Image}}, Status: {{.Status}}"
  else
    warn "MySQL container not running"
  fi

  echo ""

  # Check MySQL connection
  if command -v mysql &>/dev/null; then
    if check_mysql_connection 2>/dev/null; then
      verify_setup 2>/dev/null || true
    else
      warn "Cannot connect to MySQL"
    fi
  fi

  echo ""
  echo "=========================================="
}

# ---- Interactive Mode ----

interactive_setup() {
  echo ""
  echo "=========================================="
  echo "  Langfuse MySQL Setup"
  echo "  (ClickHouse → MySQL Migration)"
  echo "=========================================="
  echo ""

  check_prerequisites

  echo ""
  echo "Select deployment mode:"
  echo "  1) Zebra Proxy (Meituan internal — recommended for staging/production)"
  echo "  2) Direct MySQL (local dev or non-Zebra environments)"
  echo "  3) Local Docker MySQL (spin up mysql:8.0 container)"
  echo ""
  read -rp "Enter choice [1-3]: " mode_choice

  case "$mode_choice" in
    1)
      echo ""
      echo "Select deployment environment:"
      echo "  1) Production  (bjintel_langfuse_product)"
      echo "  2) Staging     (bjintel_langfuse_staging)"
      echo "  3) Test        (bjintel_langfuse_test)"
      echo "  4) Development (bjintel_langfuse_dev)"
      echo ""
      read -rp "Enter choice [1-4]: " env_choice

      local deploy_env
      case "$env_choice" in
        1) deploy_env="PRODUCTION" ;;
        2) deploy_env="STAGING" ;;
        3) deploy_env="TEST" ;;
        4) deploy_env="DEVELOPMENT" ;;
        *) deploy_env="DEVELOPMENT"; warn "Defaulting to DEVELOPMENT" ;;
      esac

      local ref_key
      ref_key=$(get_ref_key "$deploy_env")

      echo ""
      info "Configuration summary:"
      echo "  Mode:         Zebra Proxy"
      echo "  Environment:  $deploy_env"
      echo "  App name:     $DEFAULT_APP_NAME"
      echo "  ref_key:      $ref_key"
      echo "  Proxy host:   $DEFAULT_ZEBRA_PROXY_HOST"
      echo ""
      read -rp "Apply this configuration? [Y/n]: " confirm
      if [[ "${confirm:-Y}" != "n" && "${confirm:-Y}" != "N" ]]; then
        write_env_zebra "$(echo $deploy_env | tr "[:lower:]" "[:upper:]")"
        ok "Zebra Proxy setup complete!"
        info "Next steps:"
        echo "  1. Ensure the ref_key '$ref_key' is registered in the Zebra config center"
        echo "  2. Create the 'langfuse' database on the target MySQL 8.0 RDS instance"
        echo "  3. Run migrations: ./scripts/setup-mysql.sh --migrate"
        echo "  4. Start Langfuse: docker compose -f docker-compose.mysql.yml up -d"
      fi
      ;;

    2)
      echo ""
      read -rp "MySQL host [localhost]: " mysql_host
      mysql_host="${mysql_host:-localhost}"
      read -rp "MySQL port [3306]: " mysql_port
      mysql_port="${mysql_port:-3306}"
      read -rp "MySQL user [langfuse]: " mysql_user
      mysql_user="${mysql_user:-langfuse}"
      read -rsp "MySQL password: " mysql_password
      echo ""
      read -rp "MySQL database [langfuse]: " mysql_db
      mysql_db="${mysql_db:-langfuse}"

      echo ""
      info "Configuration summary:"
      echo "  Mode:    Direct MySQL"
      echo "  Host:    $mysql_host:$mysql_port"
      echo "  User:    $mysql_user"
      echo "  Database: $mysql_db"
      echo ""
      read -rp "Apply and run migrations? [Y/n]: " confirm
      if [[ "${confirm:-Y}" != "n" && "${confirm:-Y}" != "N" ]]; then
        # Write env
        cat > "$ENV_FILE" << ENVEOF
# Auto-generated by setup-mysql.sh — Direct MySQL mode
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
DIRECT_URL="postgresql://postgres:postgres@localhost:5432/postgres"
LANGFUSE_MYSQL_URL="mysql://${mysql_user}:${mysql_password}@${mysql_host}:${mysql_port}/${mysql_db}"
LANGFUSE_MYSQL_CONNECTION_LIMIT=25
DEPLOY_ENV="DEVELOPMENT"
ENVEOF
        ok ".env written"

        # Test connection and run migrations
        if check_mysql_connection "$mysql_host" "$mysql_port" "$mysql_user" "$mysql_password"; then
          run_migrations "$mysql_host" "$mysql_port" "$mysql_user" "$mysql_password" "$mysql_db"
          verify_setup "$mysql_host" "$mysql_port" "$mysql_user" "$mysql_password" "$mysql_db"
        fi
      fi
      ;;

    3)
      echo ""
      info "Starting local MySQL 8.0 Docker container..."
      start_local_mysql

      echo ""
      read -rp "Run migrations on the local container? [Y/n]: " confirm
      if [[ "${confirm:-Y}" != "n" && "${confirm:-Y}" != "N" ]]; then
        run_migrations "$DEFAULT_MYSQL_HOST" "$DEFAULT_MYSQL_PORT" "root" "$DEFAULT_MYSQL_PASSWORD" "$DEFAULT_MYSQL_DB"
        verify_setup "$DEFAULT_MYSQL_HOST" "$DEFAULT_MYSQL_PORT" "root" "$DEFAULT_MYSQL_PASSWORD" "$DEFAULT_MYSQL_DB"
      fi

      write_env_direct

      ok "Local setup complete!"
      info "Next steps:"
      echo "  1. docker compose -f docker-compose.mysql.yml up -d"
      echo "  2. Or run locally: pnpm dev"
      ;;

    *)
      err "Invalid choice"
      exit 1
      ;;
  esac
}

# ---- Main ----

main() {
  local mode="interactive"
  local deploy_env=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env)
        deploy_env="${2:-}"
        shift 2
        ;;
      --local)
        mode="local"
        shift
        ;;
      --migrate)
        mode="migrate"
        shift
        ;;
      --check)
        mode="check"
        shift
        ;;
      --help|-h)
        echo "Usage: $0 [--env ENV] [--local] [--migrate] [--check] [--help]"
        echo ""
        echo "Options:"
        echo "  --env ENV    Set environment (production/staging/test/development) with Zebra Proxy"
        echo "  --local      Set up local MySQL 8.0 Docker container"
        echo "  --migrate    Run MySQL migrations (requires running MySQL)"
        echo "  --check      Check current setup status"
        echo "  --help       Show this help"
        exit 0
        ;;
      *)
        err "Unknown option: $1"
        exit 1
        ;;
    esac
  done

  case "$mode" in
    interactive)
      if [[ -n "$deploy_env" ]]; then
        # Non-interactive with --env flag
        check_prerequisites
        local ref_key
        ref_key=$(get_ref_key "$deploy_env")
        write_env_zebra "$(echo $deploy_env | tr "[:lower:]" "[:upper:]")"
        ok "Setup complete for $deploy_env (ref_key: $ref_key)"
      else
        interactive_setup
      fi
      ;;
    local)
      check_prerequisites
      start_local_mysql
      run_migrations "$DEFAULT_MYSQL_HOST" "$DEFAULT_MYSQL_PORT" "root" "$DEFAULT_MYSQL_PASSWORD" "$DEFAULT_MYSQL_DB"
      write_env_direct
      ok "Local setup complete!"
      ;;
    migrate)
      local mysql_host="${MYSQL_HOST:-$DEFAULT_MYSQL_HOST}"
      local mysql_port="${MYSQL_PORT:-$DEFAULT_MYSQL_PORT}"
      local mysql_user="${MYSQL_USER:-root}"
      local mysql_password="${MYSQL_PASSWORD:-$DEFAULT_MYSQL_PASSWORD}"
      local mysql_db="${MYSQL_DATABASE:-$DEFAULT_MYSQL_DB}"

      if [[ -f "$ENV_FILE" ]]; then
        local mysql_url
        mysql_url=$(grep -oP '(?<=^LANGFUSE_MYSQL_URL=)["'"'"']?\K[^"'"'"'\s]+' "$ENV_FILE" 2>/dev/null || echo "")
        if [[ -n "$mysql_url" ]]; then
          info "Using LANGFUSE_MYSQL_URL from .env"
          mysql_user=$(echo "$mysql_url" | sed -n 's|.*://\([^:]*\):.*|\1|p')
          mysql_password=$(echo "$mysql_url" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
          mysql_host=$(echo "$mysql_url" | sed -n 's|.*@\([^:]*\):.*|\1|p')
          mysql_port=$(echo "$mysql_url" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
          mysql_db=$(echo "$mysql_url" | sed -n 's|.*\/\([^?]*\).*|\1|p')
        fi
      fi

      run_migrations "$mysql_host" "$mysql_port" "$mysql_user" "$mysql_password" "$mysql_db"
      verify_setup "$mysql_host" "$mysql_port" "$mysql_user" "$mysql_password" "$mysql_db"
      ;;
    check)
      show_status
      ;;
  esac
}

main "$@"
