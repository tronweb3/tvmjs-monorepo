import { MapDB } from '@tvmjs/util'
import { LevelDB } from './engines/level'
import { createSuite } from './suite'

createSuite(new MapDB())
createSuite(new LevelDB())
