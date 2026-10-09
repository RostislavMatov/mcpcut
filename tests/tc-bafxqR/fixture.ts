
      import type { DecisionInfo } from '../../src/journal/record.js'

      export const decision: DecisionInfo = {
        outcome: 'allow',
        rule: 'default',
        serverName: 'srv',
        toolName: 'read_file',
        toolClass: 'read',
        quarantineState: 'known',
        argsHash: '',
        policyHash: 'a'.repeat(64),
      }
    