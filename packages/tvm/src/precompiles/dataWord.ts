import { EthereumJSErrorWithoutCode } from '@tvmjs/util'

export class DataWord {
  static readonly WORD_SIZE = 32

  private readonly _data: Uint8Array

  constructor(buffer: Uint8Array) {
    this._data = new Uint8Array(DataWord.WORD_SIZE)
    this._data.set(buffer)
  }

  static parseArray(data: Uint8Array): DataWord[] {
    const len = Math.floor(data.length / DataWord.WORD_SIZE)
    const words = new Array(len)

    for (let i = 0; i < len; ++i) {
      const start = i * DataWord.WORD_SIZE
      const buffer = data.slice(start, start + DataWord.WORD_SIZE)
      words[i] = new DataWord(buffer)
    }
    return words
  }

  get data() {
    return this._data
  }

  intValueSafe(): number {
    const firstNonZero = this._data.findIndex((ele) => ele !== 0)
    let bytesOccupied = 0
    if (firstNonZero !== -1) {
      bytesOccupied = DataWord.WORD_SIZE - firstNonZero
    }

    const intValue = this.intValue()
    if (bytesOccupied > 4 || intValue < 0) {
      throw EthereumJSErrorWithoutCode('DataWord value does not fit in a safe integer')
    }
    return intValue
  }

  intValue(): number {
    let intVal = 0

    this._data.forEach((ele) => {
      intVal = (intVal << 8) + (ele & 0xff)
    })

    return intVal
  }

  static equalAddressByteArray(arr1: Uint8Array, arr2: Uint8Array): boolean {
    if (arr1 === arr2) {
      return true
    }
    if (arr1.length < 20 || arr2.length < 20) {
      return false
    }

    let i = arr1.length - 20
    let j = arr2.length - 20
    for (; i < arr1.length && j < arr2.length; ++i, ++j) {
      if (arr1[i] !== arr2[j]) {
        return false
      }
    }
    return true
  }

  getLast20Bytes(): Uint8Array {
    return this._data.slice(12, DataWord.WORD_SIZE)
  }
}
