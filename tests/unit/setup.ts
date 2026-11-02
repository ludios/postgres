import { replace_pg_vars } from "../pg_env.ts";

// For each option that the caller does not give, the library uses a PG* variable if it is set (the
// variables of libpq, such as PGPORT, and also "PG" + the option's name in upper case, such as
// PGMAX). So that the unit tests do not depend on the environment that vitest was started in,
// delete every PG* variable before each unit test file runs.
replace_pg_vars({});
