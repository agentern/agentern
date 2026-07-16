export async function registerNodeInstrumentation() {
  try {
    const { assertProductionConfiguration } = await import("@/lib/config")
    assertProductionConfiguration()
  } catch (error) {
    console.error(JSON.stringify({
      level: "fatal",
      event: "invalid_production_configuration",
      message: error instanceof Error ? error.message : "Configuration validation failed",
    }))
    process.exit(1)
  }
}
