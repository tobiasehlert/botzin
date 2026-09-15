import { loadRuntimeConfig } from "../config/runtime-config.js";
import { createMysqlPool } from "../database/mysql-pool.js";
import { seedVocationSkillRules } from "./seed-vocation-skill-rules.js";

const pool = createMysqlPool(loadRuntimeConfig());
try {
  const count = await seedVocationSkillRules(pool);
  console.log(count === 0
    ? "[vocation-rules] Nenhuma hunt habilitada; habilite uma no painel e rode de novo."
    : `[vocation-rules] ${count} regras gravadas, todas desabilitadas — revise no painel antes de ligar.`);
} finally {
  await pool.end();
}
