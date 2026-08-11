import { Layout } from '../components/layout.tsx'

export type HelloProps = {
  title: string
  who: string
  items: string[]
}

export function Hello({ title, who, items }: HelloProps) {
  return (
    <Layout title={title}>
      <h1 safe>Hello {who}</h1>
      <ul>
        {items.map((item) => (
          <li safe>{item}</li>
        ))}
      </ul>
    </Layout>
  )
}

export function Bare() {
  return <p>no props</p>
}
